import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Interval } from '@nestjs/schedule';
import { Model, Types } from 'mongoose';
import { CallAlert, type AlertFinding, type CallAlertDocument } from '../../schemas/call-alert.schema';
import { Call, type CallDocument } from '../../schemas/call.schema';
import { Campaign, type CampaignDocument } from '../../schemas/campaign.schema';
import { Lead, type LeadDocument } from '../../schemas/lead.schema';
import {
  DEFAULT_CALL_ALERTS,
  PlatformSettings,
  type CallAlertSettings,
  type PlatformSettingsDocument,
} from '../../schemas/platform-settings.schema';
import { findAbnormalities, type AlertCall, type AlertCampaign } from './abnormalities';
import { sendAlertEmail } from './mailer';

const TIMEZONES: Array<[string, string]> = [
  ['Melbourne', 'Australia/Melbourne'],
  ['IST', 'Asia/Kolkata'],
];

function clock(d: Date, tz: string): string {
  return d.toLocaleTimeString('en-AU', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
}

function windowLabel(from: Date, to: Date): string {
  return TIMEZONES.map(([name, tz]) => `${clock(from, tz)}–${clock(to, tz)} ${name}`).join(' / ');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

@Injectable()
export class CallAlertsService {
  private readonly logger = new Logger(CallAlertsService.name);
  private running = false;

  constructor(
    @InjectModel(PlatformSettings.name) private readonly settingsModel: Model<PlatformSettingsDocument>,
    @InjectModel(CallAlert.name) private readonly alertModel: Model<CallAlertDocument>,
    @InjectModel(Call.name) private readonly callModel: Model<CallDocument>,
    @InjectModel(Campaign.name) private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(Lead.name) private readonly leadModel: Model<LeadDocument>,
  ) {}

  async settings(): Promise<CallAlertSettings> {
    const doc = await this.settingsModel.findOne({ key: 'default' }).lean().exec();
    return { ...DEFAULT_CALL_ALERTS, ...(doc?.callAlerts ?? {}) };
  }

  async updateSettings(patch: Partial<CallAlertSettings>): Promise<CallAlertSettings> {
    const next = { ...(await this.settings()), ...patch };
    await this.settingsModel.updateOne({ key: 'default' }, { $set: { callAlerts: next } }, { upsert: true }).exec();
    return next;
  }

  history(limit = 50) {
    return this.alertModel.find().sort({ windowEnd: -1 }).limit(limit).lean().exec();
  }

  /** Ticks every minute; runs the check when `intervalMinutes` have passed since the last one. */
  @Interval(60_000)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const s = await this.settings();
      if (!s.enabled) return;
      const now = new Date();
      if (s.lastRunAt && +now - +new Date(s.lastRunAt) < s.intervalMinutes * 60_000 - 5_000) return;
      await this.settingsModel.updateOne({ key: 'default' }, { $set: { 'callAlerts.lastRunAt': now } }, { upsert: true }).exec();
      await this.check(new Date(+now - s.intervalMinutes * 60_000), now, s.recipients, false);
    } catch (e) {
      this.logger.error(`call alert check failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Looks at the calls in [from, to) and records and emails any findings.
   * `alwaysEmail` sends even when all is normal (the "Send test" button).
   */
  async check(from: Date, to: Date, recipients: string[], alwaysEmail: boolean) {
    const windowMs = +to - +from;
    const prevFrom = new Date(+from - windowMs);
    const recent = await this.callModel
      .find({ startedAt: { $gte: prevFrom, $lt: to } })
      .select('campaignId leadId startedAt answeredAt endedAt bridgedAt outcome sipStatusCode transcript.speaker timings.workerLog timings.events')
      .lean()
      .exec();
    const ids = new Set(recent.map((c) => String(c.campaignId)));
    const active = await this.campaignModel.find({ status: 'ACTIVE' }).select('_id').lean().exec();
    for (const a of active) ids.add(String(a._id));
    const campaigns = await this.campaignModel
      .find({ _id: { $in: [...ids].map((i) => new Types.ObjectId(i)) } })
      .select('name status')
      .lean()
      .exec();
    const leadIds = recent.filter((c) => (c.timings?.events ?? []).some((e) => e.kind === 'transfer')).map((c) => c.leadId);
    const leads = leadIds.length
      ? await this.leadModel.find({ _id: { $in: leadIds } }).select('firstName lastName name suburb city').lean().exec()
      : [];
    const leadLabel = new Map(
      leads.map((l) => {
        const x = l as unknown as Record<string, string | undefined>;
        const who = x.firstName ?? x.name ?? 'Lead';
        const where = x.suburb ?? x.city;
        return [String(l._id), where ? `${who}, ${where}` : who];
      }),
    );

    const findings: AlertFinding[] = [];
    const stats: CallAlert['stats'] = [];
    for (const k of campaigns) {
      const mine = recent.filter((c) => String(c.campaignId) === String(k._id));
      const inWindow = mine.filter((c) => +c.startedAt >= +from);
      const calls: AlertCall[] = inWindow.map((c) => ({
        id: String(c._id),
        startedAt: c.startedAt,
        answeredAt: c.answeredAt,
        endedAt: c.endedAt,
        bridgedAt: c.bridgedAt,
        outcome: c.outcome,
        sipStatusCode: c.sipStatusCode,
        speakers: (c.transcript ?? []).map((t) => t.speaker),
        workerLog: (c.timings?.workerLog ?? []).map((l) => l.detail),
        events: (c.timings?.events ?? []).map((e) => ({ kind: e.kind, detail: e.detail })),
        leadLabel: leadLabel.get(String(c.leadId)),
      }));
      const campaign: AlertCampaign = {
        id: String(k._id),
        name: k.name,
        status: k.status,
        calls,
        callsInPreviousWindow: mine.length - inWindow.length,
      };
      findings.push(...findAbnormalities(campaign));
      const outcomes: Record<string, number> = {};
      for (const c of inWindow) outcomes[c.outcome ?? 'LIVE'] = (outcomes[c.outcome ?? 'LIVE'] ?? 0) + 1;
      if (inWindow.length || k.status === 'ACTIVE') stats.push({ campaignName: k.name, calls: inWindow.length, outcomes });
    }

    if (!findings.length && !alwaysEmail) return { findings, stats, emailedTo: [] as string[] };

    const alert = new this.alertModel({ windowStart: from, windowEnd: to, findings, stats });
    const label = windowLabel(from, to);
    const critical = findings.filter((f) => f.severity === 'CRITICAL').length;
    const subject = findings.length
      ? `[CoCally] ${critical ? 'CRITICAL: ' : ''}${findings.length} call issue${findings.length > 1 ? 's' : ''} (${label})`
      : `[CoCally] Test alert: no call issues (${label})`;
    const { text, html } = this.render(findings, stats, label);
    if (recipients.length) {
      try {
        await sendAlertEmail(recipients, subject, text, html);
        alert.emailedTo = recipients;
      } catch (e) {
        alert.emailError = (e as Error).message;
        this.logger.warn(`call alert email not sent: ${alert.emailError}`);
      }
    } else {
      alert.emailError = 'No recipients set';
    }
    if (findings.length || alwaysEmail) await alert.save();
    this.logger.warn(`call alert: ${subject}${alert.emailError ? ` (email not sent: ${alert.emailError})` : ''}`);
    return { findings, stats, emailedTo: alert.emailedTo, emailError: alert.emailError };
  }

  private render(findings: AlertFinding[], stats: CallAlert['stats'], label: string) {
    const lines: string[] = [`Calls ${label}`, ''];
    const rows: string[] = [];
    if (!findings.length) lines.push('No abnormalities found. This is a test email.');
    for (const f of findings) {
      lines.push(`${f.severity} · ${f.campaignName}`, `  ${f.title}`, `  ${f.detail}`, '');
      const color = f.severity === 'CRITICAL' ? '#b42318' : '#b54708';
      rows.push(
        `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;vertical-align:top"><b style="color:${color}">${f.severity}</b><br><span style="color:#666">${escapeHtml(f.campaignName)}</span></td>` +
          `<td style="padding:8px 12px;border-bottom:1px solid #eee"><b>${escapeHtml(f.title)}</b><br>${escapeHtml(f.detail)}</td></tr>`,
      );
    }
    const statLine = (s: CallAlert['stats'][number]) =>
      `${s.campaignName}: ${s.calls} calls${s.calls ? ` (${Object.entries(s.outcomes).map(([k, v]) => `${k.toLowerCase().replace(/_/g, ' ')} ${v}`).join(', ')})` : ''}`;
    lines.push('', 'Window totals:', ...stats.map((s) => `  ${statLine(s)}`));
    const html =
      `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#111"><p>Calls ${escapeHtml(label)}</p>` +
      (findings.length ? `<table style="border-collapse:collapse;width:100%">${rows.join('')}</table>` : '<p>No abnormalities found. This is a test email.</p>') +
      `<p style="margin-top:16px"><b>Window totals</b><br>${stats.map((s) => escapeHtml(statLine(s))).join('<br>') || 'No calls.'}</p>` +
      `<p style="color:#888;font-size:12px">Change the interval or recipients on the ops console → Settings → Call alerts.</p></div>`;
    return { text: lines.join('\n'), html };
  }
}

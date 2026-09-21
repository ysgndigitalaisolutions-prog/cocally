import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Marks a route reachable by a privileged user who has not yet enrolled TOTP.
 * Only the routes needed to complete enrolment (and to read one's own profile)
 * should carry this; everything else is refused with TWO_FACTOR_REQUIRED.
 */
export const SKIP_2FA_KEY = 'skip2fa';
export const AllowWithout2fa = () => SetMetadata(SKIP_2FA_KEY, true);

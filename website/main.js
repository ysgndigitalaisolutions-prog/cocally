/* CoCally — co-cally.com — interactions & animations */
(function () {
  "use strict";
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- nav ---------- */
  const nav = $("#nav");
  const progress = $("#progressBar");
  const onScroll = () => {
    nav.classList.toggle("scrolled", window.scrollY > 24);
    const h = document.documentElement;
    const pct = (h.scrollTop / (h.scrollHeight - h.clientHeight)) * 100;
    progress.style.width = pct + "%";
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  const burger = $("#navBurger");
  const mobile = $("#navMobile");
  burger.addEventListener("click", () => {
    const open = burger.classList.toggle("open");
    mobile.classList.toggle("open", open);
    burger.setAttribute("aria-expanded", String(open));
  });
  $$("a", mobile).forEach((a) =>
    a.addEventListener("click", () => {
      burger.classList.remove("open");
      mobile.classList.remove("open");
      burger.setAttribute("aria-expanded", "false");
    })
  );

  /* ---------- scroll reveal ---------- */
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add("in");
          io.unobserve(e.target);
          if (e.target.classList.contains("stats-band")) runCounters(e.target);
          if (e.target.closest("#onboarding")) fillTimeline();
        }
      });
    },
    { threshold: 0.15, rootMargin: "0px 0px -40px 0px" }
  );
  $$(".reveal").forEach((el) => io.observe(el));

  /* ---------- animated counters ---------- */
  function runCounters(band) {
    $$(".stat-num", band).forEach((el) => {
      const target = parseInt(el.dataset.count, 10);
      const prefix = el.dataset.prefix || "";
      const suffix = el.dataset.suffix || "";
      if (reduceMotion) {
        el.textContent = prefix + target.toLocaleString() + suffix;
        return;
      }
      const dur = 1400;
      const t0 = performance.now();
      (function tick(t) {
        const p = Math.min((t - t0) / dur, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = prefix + Math.round(target * eased).toLocaleString() + suffix;
        if (p < 1) requestAnimationFrame(tick);
      })(t0);
    });
  }

  /* ---------- onboarding timeline fill ---------- */
  let timelineDone = false;
  function fillTimeline() {
    if (timelineDone) return;
    timelineDone = true;
    const fill = $("#timelineFill");
    if (fill) requestAnimationFrame(() => (fill.style.width = "100%"));
  }

  /* ---------- capability card cursor glow ---------- */
  $$(".cap-card").forEach((card) => {
    card.addEventListener("pointermove", (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", e.clientX - r.left + "px");
      card.style.setProperty("--my", e.clientY - r.top + "px");
    });
  });

  /* ---------- hero: live-call simulation loop ---------- */
  const transcript = $("#transcript");
  const scoreFill = $("#scoreFill");
  const scoreNum = $("#scoreNum");
  const factsRow = $("#factsRow");
  const transferCard = $("#transferCard");
  const tcBridge = $("#tcBridge");
  const callBadge = $("#callBadge");
  const callTimer = $("#callTimer");

  const SCRIPT = [
    { who: "ai", text: "Hi Sarah! This is Ava from Aurora Solar — you just requested a solar quote on our site. I'm an AI assistant. Do you have a quick minute?", score: 5 },
    { who: "cust", text: "Oh wow, that was fast — sure.", score: 10 },
    { who: "ai", text: "Great! So I can get you an accurate quote — do you own your home in Richmond?", score: 18 },
    { who: "cust", text: "Yeah, we own it.", score: 38, fact: "owner ✓" },
    { who: "ai", text: "Great. Roughly what's your quarterly electricity bill?", score: 44 },
    { who: "cust", text: "Around $540 a quarter… it's getting ridiculous.", score: 68, fact: "bill $540/qtr ✓" },
    { who: "cust", text: "Are there still battery rebates? We'd want it in before summer.", score: 91, fact: "timeline: pre-summer ✓" },
  ];

  let step = 0;
  let seconds = 0;
  let timerId = null;

  function fmt(s) {
    return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }

  function setScore(v) {
    scoreFill.style.width = v + "%";
    scoreNum.textContent = v;
  }

  function addBubble(item) {
    const b = document.createElement("div");
    b.className = "bubble " + (item.who === "ai" ? "bubble-ai" : "bubble-cust");
    b.innerHTML =
      '<span class="who">' + (item.who === "ai" ? "CoCally AI" : "Customer") + "</span>" + item.text;
    transcript.appendChild(b);
    while (transcript.children.length > 4) transcript.removeChild(transcript.firstChild);
  }

  function addTyping(who) {
    const t = document.createElement("div");
    t.className = "bubble bubble-typing " + (who === "ai" ? "bubble-ai" : "bubble-cust");
    t.innerHTML = "<i></i><i></i><i></i>";
    transcript.appendChild(t);
    while (transcript.children.length > 4) transcript.removeChild(transcript.firstChild);
    return t;
  }

  function addFact(text) {
    const c = document.createElement("span");
    c.className = "fact-chip";
    c.textContent = text;
    factsRow.appendChild(c);
  }

  function playStep() {
    if (step >= SCRIPT.length) return finale();
    const item = SCRIPT[step];
    const typing = addTyping(item.who);
    setTimeout(() => {
      typing.remove();
      addBubble(item);
      setScore(item.score);
      if (item.fact) addFact(item.fact);
      step++;
      setTimeout(playStep, item.who === "ai" ? 1500 : 1900);
    }, item.who === "ai" ? 1100 : 1500);
  }

  function finale() {
    callBadge.innerHTML = '<span class="pulse-dot"></span> Transferring…';
    setTimeout(() => {
      transferCard.classList.add("show");
      transferCard.setAttribute("aria-hidden", "false");
      let t = 12;
      const tcTimer = $("#tcTimer");
      const cd = setInterval(() => {
        t--;
        tcTimer.textContent = t + "s";
        if (t <= 9) {
          clearInterval(cd);
          tcBridge.classList.add("show");
          callBadge.innerHTML = '<span class="pulse-dot"></span> Human on call';
          setTimeout(resetLoop, 6000);
        }
      }, 900);
    }, 700);
  }

  function resetLoop() {
    transferCard.classList.remove("show");
    transferCard.setAttribute("aria-hidden", "true");
    tcBridge.classList.remove("show");
    $("#tcTimer").textContent = "12s";
    transcript.innerHTML = "";
    factsRow.innerHTML = "";
    setScore(0);
    seconds = 0;
    step = 0;
    callBadge.innerHTML = '<span class="pulse-dot"></span> AI on call';
    setTimeout(playStep, 1200);
  }

  function startCallSim() {
    if (reduceMotion) {
      // Static final state for reduced-motion users
      SCRIPT.slice(3).forEach(addBubble);
      setScore(91);
      ["owner ✓", "bill $540/qtr ✓", "timeline: pre-summer ✓"].forEach(addFact);
      transferCard.classList.add("show");
      tcBridge.classList.add("show");
      callTimer.textContent = "02:47";
      return;
    }
    timerId = setInterval(() => {
      seconds++;
      callTimer.textContent = fmt(seconds);
    }, 1000);
    setTimeout(playStep, 900);
  }

  // Only run the sim when visible (saves battery, restarts cleanly)
  const heroSim = $("#callCard");
  if (heroSim) {
    const simIo = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          startCallSim();
          simIo.disconnect();
        }
      },
      { threshold: 0.3 }
    );
    simIo.observe(heroSim);
  }
})();

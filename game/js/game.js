// "use strict";
// /* ══════════════════════════════════════════════════════════════
//    MOLEFIELD — Game State & Rules Engine
//    Manages rounds, levels, mole hole grids, spawning probabilities,
//    dwell-to-whack mechanics, and scoring streaks.
//    ══════════════════════════════════════════════════════════════ */

// const G = {
//   phase: "start", // "start" | "count" | "play" | "levelup" | "over" | "pause"
//   li: 0,
//   score: 0,
//   streak: 1,
//   missed: 0,
//   hitsThisLevel: 0,
//   t: 0,
//   holes: [],
//   moles: [],
//   fx: [],
//   dwell: 0,
//   dwellTarget: null,
//   alarm: false,
//   alarmT: 0,
//   cd: 0,
//   cdShown: -1,
//   endCdShown: -1,
//   totalHits: 0,
//   totalShown: 0,
//   bestStreak: 1
// };

// // function buildHoles() {
// //   const L = LEVELS[G.li];
// //   G.holes = [];
// //   const mx = 0.16, my = 0.16; // Margins in normalized play-field units

// //   for (let r = 0; r < L.rows; r++) {
// //     for (let c = 0; c < L.cols; c++) {
// //       const u = L.cols === 1 ? 0.5 : mx + (c / (L.cols - 1)) * (1.0 - 2.0 * mx);
// //       const v = L.rows === 1 ? 0.5 : my + (r / (L.rows - 1)) * (1.0 - 2.0 * my);
// //       G.holes.push({
// //         u,
// //         v,
// //         x: u * AREA.w,
// //         y: AREA.yNear + v * AREA.deep,
// //         occupied: null
// //       });
// //     }
// //   }
// // }

// function buildHoles() {
//   const L = LEVELS[G.li];
//   G.holes = [];

//   const mx = 0.16;
//   const my = 0.16;

//   // Random holes for levels that have randomHoles enabled
//   if (L.randomHoles) {
//     const total = L.cols * L.rows;

//     for (let i = 0; i < total; i++) {
//       let u, v;
//       let valid = false;

//       // Keep generating a position until it is far enough
//       // away from all existing holes
//       while (!valid) {
//         u = mx + Math.random() * (1.0 - 2.0 * mx);
//         v = my + Math.random() * (1.0 - 2.0 * my);

//         valid = true;

//         for (const h of G.holes) {
//           const dx = u - h.u;
//           const dy = v - h.v;
//           const distance = Math.sqrt(dx * dx + dy * dy);

//           if (distance < 0.18) {
//             valid = false;
//             break;
//           }
//         }
//       }

//       G.holes.push({
//         u,
//         v,
//         x: u * AREA.w,
//         y: AREA.yNear + v * AREA.deep,
//         occupied: null
//       });
//     }

//     return;
//   }

//   // Normal grid for levels without randomHoles
//   for (let r = 0; r < L.rows; r++) {
//     for (let c = 0; c < L.cols; c++) {
//       const u = L.cols === 1
//         ? 0.5
//         : mx + (c / (L.cols - 1)) * (1.0 - 2.0 * mx);

//       const v = L.rows === 1
//         ? 0.5
//         : my + (r / (L.rows - 1)) * (1.0 - 2.0 * my);

//       G.holes.push({
//         u,
//         v,
//         x: u * AREA.w,
//         y: AREA.yNear + v * AREA.deep,
//         occupied: null
//       });
//     }
//   }
// }

// function startLevel(i) {
//   G.li = i;
//   G.t = LEVELS[i].dur;
//   G.hitsThisLevel = 0;
//   G.moles = [];
//   G.fx = [];
//   G.dwell = 0;
//   G.dwellTarget = null;
//   buildHoles();

//   // Hold the round in a 5-second countdown before play begins.
//   G.cd = 5.0;
//   G.cdShown = -1;
//   G.endCdShown = -1;
//   G.phase = "count";
//   showCountdown(5, "GET READY");
// }

// /* \u2500\u2500 Countdown display \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
// function showCountdown(n, label) {
//   const cd = document.getElementById("cd");
//   const num = document.getElementById("cdnum");
//   const lab = document.getElementById("cdlab");
//   if (!cd || !num) return;

//   num.textContent = n;
//   if (lab) lab.textContent = label || "";
//   cd.hidden = false;

//   // Restart the pop animation on every tick.
//   num.classList.remove("tick");
//   void num.offsetWidth;
//   num.classList.add("tick");

//   cd.classList.toggle("final", n <= 3);
// }

// function hideCountdown() {
//   const cd = document.getElementById("cd");
//   if (cd) cd.hidden = true;
// }

// function resetRun(startAt = 0) {
//   G.score = 0;
//   G.streak = 1;
//   G.missed = 0;
//   G.totalHits = 0;
//   G.totalShown = 0;
//   G.bestStreak = 1;
//   startLevel(Math.max(0, Math.min(startAt, LEVELS.length - 1)));
// }

// function spawn() {
//   const L = LEVELS[G.li];
//   const free = G.holes.filter(h => !h.occupied);
//   if (!free.length) return;

//   const h = free[(Math.random() * free.length) | 0];
//   let kind = "mole";
//   const roll = Math.random();
//   if (L.bombs && roll < 0.16) kind = "bomb";
//   else if (L.gold && roll < 0.28) kind = "gold";
//   if (kind === "mole" && Math.random() < 0.4) kind = "prof"; // Iain mole, all levels

//   const m = {
//     hole: h,
//     kind,
//     life: L.life * (kind === "gold" ? 0.8 : 1.0) * (0.85 + Math.random() * 0.3),
//     age: 0,
//     state: "rise",
//     pop: 0,
//     dwell: 0,
//     dead: false
//   };

//   h.occupied = m;
//   G.moles.push(m);
//   if (kind !== "bomb") G.totalShown++;
// }

// function hit(m) {
//   const L = LEVELS[G.li];

//   if (m.kind === "bomb") {
//     G.score = Math.max(0, G.score - 15);
//     G.streak = 1;
//     Audio_.bomb();
//     G.fx.push({
//       type: "burst",
//       x: m.hole.x,
//       y: m.hole.y,
//       t: 0,
//       col: "#FF4D3D",
//       text: "−15"
//     });
//     shake = 0.35;
//   } else {
//     const base = m.kind === "prof" ? 50 : m.kind === "gold" ? 30 : 10;
//     const pts = base * G.streak;
//     G.score += pts;
//     G.hitsThisLevel++;
//     G.totalHits++;
//     G.streak = Math.min(8, G.streak + 1);
//     G.bestStreak = Math.max(G.bestStreak, G.streak);

//     if (m.kind === "prof") Audio_.prof();
//     else if (m.kind === "gold") Audio_.gold();
//     else Audio_.whack();

//     G.fx.push({
//       type: "burst",
//       x: m.hole.x,
//       y: m.hole.y,
//       t: 0,
//       col: m.kind === "prof" ? "#7FD3FF" : m.kind === "gold" ? "#FFB020" : "#9BE86B",
//       text: m.kind === "prof" ? "+" + pts + " IAIN!" : "+" + pts
//     });
//   }

//   m.dead = true;
//   m.state = "hit";
//   if (G.hitsThisLevel >= L.target) levelComplete();
// }

// function levelComplete() {
//   hideCountdown();
//   if (G.li >= LEVELS.length - 1) {
//     endRun("You cleared every level");
//     return;
//   }
//   G.phase = "levelup";
//   Audio_.level();
//   Audio_.alarmOff();
//   const dz = document.getElementById("dz");
//   if (dz) dz.classList.remove("on");

//   const nx = LEVELS[G.li + 1];
//   const lvBig = document.getElementById("lvBig");
//   const lvName = document.getElementById("lvName");
//   const lvDesc = document.getElementById("lvDesc");

//   if (lvBig) lvBig.textContent = nx.n;
//   if (lvName) lvName.textContent = nx.name;
//   if (lvDesc) lvDesc.textContent = nx.desc;

//   showOverlay("#ovLevel");
// }

// function endRun(title) {
//   hideCountdown();
//   G.phase = "over";
//   Audio_.over();
//   Audio_.alarmOff();
//   const dz = document.getElementById("dz");
//   if (dz) dz.classList.remove("on");

//   const endTitle = document.getElementById("endTitle");
//   const endScore = document.getElementById("endScore");
//   const endStats = document.getElementById("endStats");

//   if (endTitle) endTitle.textContent = title;
//   if (endScore) endScore.textContent = G.score;

//   const acc = G.totalShown ? Math.round((100 * G.totalHits) / G.totalShown) : 0;
//   if (endStats) {
//     endStats.textContent = `Level ${LEVELS[G.li].n} · ${G.totalHits} whacked · ${acc}% of moles caught · best streak ×${G.bestStreak}`;
//   }

//   showOverlay("#ovEnd");
// }

// function showOverlay(sel) {
//   ["#ovStart", "#ovLevel", "#ovEnd", "#ovPause", "#ovSetup"].forEach(s => {
//     const el = document.querySelector(s);
//     if (el) el.hidden = s !== sel;
//   });
// }

// function hideAllOverlays() {
//   ["#ovStart", "#ovLevel", "#ovEnd", "#ovPause", "#ovSetup"].forEach(s => {
//     const el = document.querySelector(s);
//     if (el) el.hidden = true;
//   });
// }

// "use strict";
// /* ══════════════════════════════════════════════════════════════
//    MOLEFIELD — Game State & Rules Engine
//    Manages rounds, levels, mole hole grids, spawning probabilities,
//    dwell-to-whack mechanics, and scoring streaks.
//    ══════════════════════════════════════════════════════════════ */

// const G = {
//   phase: "start", // "start" | "count" | "play" | "levelup" | "over" | "pause"
//   li: 0,
//   score: 0,
//   streak: 1,
//   missed: 0,
//   hitsThisLevel: 0,
//   t: 0,
//   holes: [],
//   moles: [],
//   fx: [],
//   dwell: 0,
//   dwellTarget: null,
//   alarm: false,
//   alarmT: 0,
//   cd: 0,
//   cdShown: -1,
//   endCdShown: -1,
//   totalHits: 0,
//   totalShown: 0,
//   bestStreak: 1
// };

// // function buildHoles() {
// //   const L = LEVELS[G.li];
// //   G.holes = [];
// //   const mx = 0.16, my = 0.16; // Margins in normalized play-field units

// //   for (let r = 0; r < L.rows; r++) {
// //     for (let c = 0; c < L.cols; c++) {
// //       const u = L.cols === 1 ? 0.5 : mx + (c / (L.cols - 1)) * (1.0 - 2.0 * mx);
// //       const v = L.rows === 1 ? 0.5 : my + (r / (L.rows - 1)) * (1.0 - 2.0 * my);
// //       G.holes.push({
// //         u,
// //         v,
// //         x: u * AREA.w,
// //         y: AREA.yNear + v * AREA.deep,
// //         occupied: null
// //       });
// //     }
// //   }
// // }

// function buildHoles() {
//   const L = LEVELS[G.li];
//   G.holes = [];

//   const mx = 0.16;
//   const my = 0.16;

//   // Random holes for levels that have randomHoles enabled
//   if (L.randomHoles) {
//     const total = L.cols * L.rows;

//     for (let i = 0; i < total; i++) {
//       let u, v;
//       let valid = false;

//       // Keep generating a position until it is far enough
//       // away from all existing holes
//       while (!valid) {
//         u = mx + Math.random() * (1.0 - 2.0 * mx);
//         v = my + Math.random() * (1.0 - 2.0 * my);

//         valid = true;

//         for (const h of G.holes) {
//           const dx = u - h.u;
//           const dy = v - h.v;
//           const distance = Math.sqrt(dx * dx + dy * dy);

//           if (distance < 0.18) {
//             valid = false;
//             break;
//           }
//         }
//       }

//       G.holes.push({
//         u,
//         v,
//         x: u * AREA.w,
//         y: AREA.yNear + v * AREA.deep,
//         occupied: null
//       });
//     }

//     return;
//   }

//   // Normal grid for levels without randomHoles
//   for (let r = 0; r < L.rows; r++) {
//     for (let c = 0; c < L.cols; c++) {
//       const u = L.cols === 1
//         ? 0.5
//         : mx + (c / (L.cols - 1)) * (1.0 - 2.0 * mx);

//       const v = L.rows === 1
//         ? 0.5
//         : my + (r / (L.rows - 1)) * (1.0 - 2.0 * my);

//       G.holes.push({
//         u,
//         v,
//         x: u * AREA.w,
//         y: AREA.yNear + v * AREA.deep,
//         occupied: null
//       });
//     }
//   }
// }

// function startLevel(i) {
//   G.li = i;
//   G.t = LEVELS[i].dur;
//   G.hitsThisLevel = 0;
//   G.moles = [];
//   G.fx = [];
//   G.dwell = 0;
//   G.dwellTarget = null;
//   buildHoles();

//   // Hold the round in a 5-second countdown before play begins.
//   G.cd = 5.0;
//   G.cdShown = -1;
//   G.endCdShown = -1;
//   G.phase = "count";
//   showCountdown(5, "GET READY");
// }

// /* \u2500\u2500 Countdown display \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
// function showCountdown(n, label) {
//   const cd = document.getElementById("cd");
//   const num = document.getElementById("cdnum");
//   const lab = document.getElementById("cdlab");
//   if (!cd || !num) return;

//   num.textContent = n;
//   if (lab) lab.textContent = label || "";
//   cd.hidden = false;

//   // Restart the pop animation on every tick.
//   num.classList.remove("tick");
//   void num.offsetWidth;
//   num.classList.add("tick");

//   cd.classList.toggle("final", n <= 3);
// }

// function hideCountdown() {
//   const cd = document.getElementById("cd");
//   if (cd) cd.hidden = true;
// }

// function resetRun(startAt = 0) {
//   const ask = document.getElementById("scoreAsk");
//   if (ask) ask.querySelector("#scoreSkip").click();   // unanswered name prompt: save as Anonymous
//   G.score = 0;
//   G.streak = 1;
//   G.missed = 0;
//   G.totalHits = 0;
//   G.totalShown = 0;
//   G.bestStreak = 1;
//   startLevel(Math.max(0, Math.min(startAt, LEVELS.length - 1)));
// }

// function spawn() {
//   const L = LEVELS[G.li];
//   const free = G.holes.filter(h => !h.occupied);
//   if (!free.length) return;

//   const h = free[(Math.random() * free.length) | 0];
//   let kind = "mole";
//   const roll = Math.random();
//   if (L.bombs && roll < 0.16) kind = "bomb";
//   else if (L.gold && roll < 0.28) kind = "gold";
//   if (kind === "mole" && Math.random() < 0.4) kind = "prof"; // Iain mole, all levels

//   const m = {
//     hole: h,
//     kind,
//     life: L.life * (kind === "gold" ? 0.8 : 1.0) * (0.85 + Math.random() * 0.3),
//     age: 0,
//     state: "rise",
//     pop: 0,
//     dwell: 0,
//     dead: false
//   };

//   h.occupied = m;
//   G.moles.push(m);
//   if (kind !== "bomb") G.totalShown++;
// }

// function hit(m) {
//   const L = LEVELS[G.li];

//   if (m.kind === "bomb") {
//     G.score = Math.max(0, G.score - 15);
//     G.streak = 1;
//     Audio_.bomb();
//     G.fx.push({
//       type: "burst",
//       x: m.hole.x,
//       y: m.hole.y,
//       t: 0,
//       col: "#FF4D3D",
//       text: "−15"
//     });
//     shake = 0.35;
//   } else {
//     const base = m.kind === "prof" ? 50 : m.kind === "gold" ? 30 : 10;
//     const pts = base * G.streak;
//     G.score += pts;
//     G.hitsThisLevel++;
//     G.totalHits++;
//     G.streak = Math.min(8, G.streak + 1);
//     G.bestStreak = Math.max(G.bestStreak, G.streak);

//     if (m.kind === "prof") Audio_.prof();
//     else if (m.kind === "gold") Audio_.gold();
//     else Audio_.whack();

//     G.fx.push({
//       type: "burst",
//       x: m.hole.x,
//       y: m.hole.y,
//       t: 0,
//       col: m.kind === "prof" ? "#7FD3FF" : m.kind === "gold" ? "#FFB020" : "#9BE86B",
//       text: m.kind === "prof" ? "+" + pts + " IAIN!" : "+" + pts
//     });
//   }

//   m.dead = true;
//   m.state = "hit";
//   if (G.hitsThisLevel >= L.target) levelComplete();
// }

// function levelComplete() {
//   hideCountdown();
//   if (G.li >= LEVELS.length - 1) {
//     endRun("You cleared every level");
//     return;
//   }
//   G.phase = "levelup";
//   Audio_.level();
//   Audio_.alarmOff();
//   const dz = document.getElementById("dz");
//   if (dz) dz.classList.remove("on");

//   const nx = LEVELS[G.li + 1];
//   const lvBig = document.getElementById("lvBig");
//   const lvName = document.getElementById("lvName");
//   const lvDesc = document.getElementById("lvDesc");

//   if (lvBig) lvBig.textContent = nx.n;
//   if (lvName) lvName.textContent = nx.name;
//   if (lvDesc) lvDesc.textContent = nx.desc;

//   showOverlay("#ovLevel");
// }

// function endRun(title) {
//   hideCountdown();
//   G.phase = "over";
//   Audio_.over();
//   Audio_.alarmOff();
//   const dz = document.getElementById("dz");
//   if (dz) dz.classList.remove("on");

//   const endTitle = document.getElementById("endTitle");
//   const endScore = document.getElementById("endScore");
//   const endStats = document.getElementById("endStats");

//   if (endTitle) endTitle.textContent = title;
//   if (endScore) endScore.textContent = G.score;

//   const acc = G.totalShown ? Math.round((100 * G.totalHits) / G.totalShown) : 0;
//   if (endStats) {
//     endStats.textContent = `Level ${LEVELS[G.li].n} · ${G.totalHits} whacked · ${acc}% of moles caught · best streak ×${G.bestStreak}`;
//   }

//   showOverlay("#ovEnd");
//   recordRun();
// }

// function showOverlay(sel) {
//   ["#ovStart", "#ovLevel", "#ovEnd", "#ovPause", "#ovSetup"].forEach(s => {
//     const el = document.querySelector(s);
//     if (el) el.hidden = s !== sel;
//   });
// }

// function hideAllOverlays() {
//   ["#ovStart", "#ovLevel", "#ovEnd", "#ovPause", "#ovSetup"].forEach(s => {
//     const el = document.querySelector(s);
//     if (el) el.hidden = true;
//   });
// }


// /* ------------------------------------------------------------------ *
//  * Scoreboard: persistent history + name entry.
//  * Stored in localStorage (this browser). Newest entry is last.
//  * Everything is built from JS, so no index.html change is needed.
//  * ------------------------------------------------------------------ */
// const Scores = {
//   KEY: "molefield.scores",
//   NAME_KEY: "molefield.lastname",
//   KEEP_BETWEEN_RUNS: false,   // false: scores reset every time the game is launched (new tab).
//                               // true: scores are kept for good in this browser.
//   MAX: 5,              // how many scores the scoreboard keeps
//   list: [],
//   lastSaved: null,     // entry saved at the end of the most recent run
//   flash: 0,            // seconds left of the "new high score" glow on the panel

//   store() {
//     // sessionStorage lives only as long as the tab: a fresh launch starts empty,
//     // but a page refresh keeps the scores.
//     try { return this.KEEP_BETWEEN_RUNS ? localStorage : sessionStorage; } catch (e) { return localStorage; }
//   },
//   load() {
//     try {
//       const a = JSON.parse(this.store().getItem(this.KEY) || "[]");
//       this.list = Array.isArray(a) ? a.filter(e => e && typeof e.score === "number") : [];
//       this.list = this.top(this.MAX);
//     } catch (e) { this.list = []; }
//   },
//   persist() {
//     try { this.store().setItem(this.KEY, JSON.stringify(this.list.slice(-this.MAX))); } catch (e) {}
//   },
//   best() { return this.list.reduce((m, e) => Math.max(m, e.score), 0); },
//   top(n) {
//     // highest score first; on a tie the earlier run keeps the higher rank
//     return this.list.map((e, i) => ({ e, i }))
//       .sort((a, b) => b.e.score - a.e.score || a.i - b.i)
//       .slice(0, n).map(x => x.e);
//   },
//   lastName() { try { return localStorage.getItem(this.NAME_KEY) || ""; } catch (e) { return ""; } },
//   add(name, run) {
//     name = (name || "").trim().slice(0, 14) || "Anonymous";
//     try { localStorage.setItem(this.NAME_KEY, name === "Anonymous" ? "" : name); } catch (e) {}
//     const entry = {
//       name, score: run.score, level: run.level, hits: run.hits,
//       acc: run.acc, streak: run.streak, t: Date.now(),
//     };
//     const wasHigh = entry.score > this.best();
//     this.list.push(entry);
//     this.list = this.top(this.MAX);   // keep only the best MAX scores
//     this.persist();
//     this.lastSaved = entry;
//     if (wasHigh) this.flash = 4;
//     return wasHigh;
//   },
//   clear() { this.list = []; this.lastSaved = null; this.persist(); },

//   /* Name prompt shown on top of the end screen. */
//   ask(run) {
//     const old = document.getElementById("scoreAsk");
//     if (old) old.remove();
//     const isHigh = run.score > this.best();

//     const wrap = document.createElement("div");
//     wrap.id = "scoreAsk";
//     wrap.style.cssText =
//       "position:fixed;left:50%;bottom:6%;transform:translateX(-50%);z-index:9999;" +
//       "background:#10161d;border:1px solid " + (isHigh ? "#FFB020" : "rgba(255,255,255,.2)") + ";" +
//       "border-radius:14px;padding:16px 18px;display:flex;flex-direction:column;gap:10px;" +
//       "font:600 14px 'Bahnschrift','DIN Alternate',sans-serif;color:#fff;" +
//       "box-shadow:0 10px 40px rgba(0,0,0,.6);min-width:280px;";
//     wrap.innerHTML =
//       '<div style="color:' + (isHigh ? "#FFB020" : "#9BE86B") + ';font-size:16px;">' +
//       (isHigh ? "★ NEW HIGH SCORE: " + run.score : "Score: " + run.score) + "</div>" +
//       '<div style="color:#9aa7b4;font-weight:500;">Enter your name for the scoreboard</div>' +
//       '<input id="scoreName" maxlength="14" autocomplete="off" placeholder="Your name" ' +
//       'style="padding:9px 11px;border-radius:8px;border:1px solid rgba(255,255,255,.25);' +
//       'background:#0b0f14;color:#fff;font:inherit;outline:none;">' +
//       '<div style="display:flex;gap:8px;">' +
//       '<button id="scoreSave" style="flex:1;padding:9px;border:0;border-radius:8px;background:#9BE86B;color:#0b0f14;font:inherit;cursor:pointer;">Save</button>' +
//       '<button id="scoreSkip" style="padding:9px 14px;border:1px solid rgba(255,255,255,.25);border-radius:8px;background:none;color:#fff;font:inherit;cursor:pointer;">Skip</button>' +
//       "</div>";
//     document.body.appendChild(wrap);

//     const input = wrap.querySelector("#scoreName");
//     input.value = this.lastName();
//     setTimeout(() => { input.focus(); input.select(); }, 30);

//     let done = false;
//     const finish = (name) => {
//       if (done) return;
//       done = true;
//       this.add(name, run);
//       wrap.remove();
//     };
//     // keep typing from triggering game shortcuts (space/P/etc.)
//     ["keydown", "keyup", "keypress"].forEach(ev =>
//       input.addEventListener(ev, e => {
//         e.stopPropagation();
//         if (ev === "keydown" && e.key === "Enter") finish(input.value);
//       }));
//     wrap.querySelector("#scoreSave").onclick = () => finish(input.value);
//     wrap.querySelector("#scoreSkip").onclick = () => finish("");
//   },
// };
// Scores.load();

// /* Offer the name prompt whenever a run ends with a score. */
// function recordRun() {
//   if (!G.score || G.score <= 0) return;
//   const acc = G.totalShown ? Math.round((100 * G.totalHits) / G.totalShown) : 0;
//   Scores.ask({
//     score: G.score, level: LEVELS[G.li].n, hits: G.totalHits, acc, streak: G.bestStreak,
//   });
// }

"use strict";
/* ══════════════════════════════════════════════════════════════
   MOLEFIELD — Game State & Rules Engine
   Manages rounds, levels, mole hole grids, spawning probabilities,
   dwell-to-whack mechanics, and scoring streaks.
   ══════════════════════════════════════════════════════════════ */

const FREEZE_SECONDS = 5.0;   // how long an ice mole freezes the moles
const ICE_CHANCE = 0.55;      // chance a normal mole turns into an ice mole on levels with freezeMoles: true (about 1 mole in 10 overall)

const G = {
  phase: "start", // "start" | "count" | "play" | "levelup" | "over" | "pause"
  li: 0,
  score: 0,
  streak: 1,
  missed: 0,
  hitsThisLevel: 0,
  t: 0,
  holes: [],
  moles: [],
  fx: [],
  dwell: 0,
  dwellTarget: null,
  alarm: false,
  alarmT: 0,
  cd: 0,
  cdShown: -1,
  endCdShown: -1,
  totalHits: 0,
  totalShown: 0,
  bestStreak: 1,
  freeze: 0       // seconds of FREEZE left: mole timers stop while this is above 0
};

// function buildHoles() {
//   const L = LEVELS[G.li];
//   G.holes = [];
//   const mx = 0.16, my = 0.16; // Margins in normalized play-field units

//   for (let r = 0; r < L.rows; r++) {
//     for (let c = 0; c < L.cols; c++) {
//       const u = L.cols === 1 ? 0.5 : mx + (c / (L.cols - 1)) * (1.0 - 2.0 * mx);
//       const v = L.rows === 1 ? 0.5 : my + (r / (L.rows - 1)) * (1.0 - 2.0 * my);
//       G.holes.push({
//         u,
//         v,
//         x: u * AREA.w,
//         y: AREA.yNear + v * AREA.deep,
//         occupied: null
//       });
//     }
//   }
// }

function buildHoles() {
  const L = LEVELS[G.li];
  G.holes = [];

  const mx = 0.16;
  const my = 0.16;

  // Random holes for levels that have randomHoles enabled
  if (L.randomHoles) {
    const total = L.cols * L.rows;

    for (let i = 0; i < total; i++) {
      let u, v;
      let valid = false;

      // Keep generating a position until it is far enough
      // away from all existing holes
      while (!valid) {
        u = mx + Math.random() * (1.0 - 2.0 * mx);
        v = my + Math.random() * (1.0 - 2.0 * my);

        valid = true;

        for (const h of G.holes) {
          const dx = u - h.u;
          const dy = v - h.v;
          const distance = Math.sqrt(dx * dx + dy * dy);

          if (distance < 0.18) {
            valid = false;
            break;
          }
        }
      }

      G.holes.push({
        u,
        v,
        x: u * AREA.w,
        y: AREA.yNear + v * AREA.deep,
        occupied: null
      });
    }

    return;
  }

  // Normal grid for levels without randomHoles
  for (let r = 0; r < L.rows; r++) {
    for (let c = 0; c < L.cols; c++) {
      const u = L.cols === 1
        ? 0.5
        : mx + (c / (L.cols - 1)) * (1.0 - 2.0 * mx);

      const v = L.rows === 1
        ? 0.5
        : my + (r / (L.rows - 1)) * (1.0 - 2.0 * my);

      G.holes.push({
        u,
        v,
        x: u * AREA.w,
        y: AREA.yNear + v * AREA.deep,
        occupied: null
      });
    }
  }
}

function startLevel(i) {
  G.li = i;
  G.t = LEVELS[i].dur;
  G.hitsThisLevel = 0;
  G.freeze = 0;
  G.moles = [];
  G.fx = [];
  G.dwell = 0;
  G.dwellTarget = null;
  buildHoles();

  // Hold the round in a 5-second countdown before play begins.
  G.cd = 5.0;
  G.cdShown = -1;
  G.endCdShown = -1;
  G.phase = "count";
  showCountdown(5, "GET READY");
}

/* \u2500\u2500 Countdown display \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
function showCountdown(n, label) {
  const cd = document.getElementById("cd");
  const num = document.getElementById("cdnum");
  const lab = document.getElementById("cdlab");
  if (!cd || !num) return;

  num.textContent = n;
  if (lab) lab.textContent = label || "";
  cd.hidden = false;

  // Restart the pop animation on every tick.
  num.classList.remove("tick");
  void num.offsetWidth;
  num.classList.add("tick");

  cd.classList.toggle("final", n <= 3);
}

function hideCountdown() {
  const cd = document.getElementById("cd");
  if (cd) cd.hidden = true;
}

function resetRun(startAt = 0) {
  const ask = document.getElementById("scoreAsk");
  if (ask) ask.querySelector("#scoreSkip").click();   // unanswered name prompt: save as Anonymous
  G.score = 0;
  G.streak = 1;
  G.missed = 0;
  G.totalHits = 0;
  G.totalShown = 0;
  G.bestStreak = 1;
  startLevel(Math.max(0, Math.min(startAt, LEVELS.length - 1)));
}

function spawn() {
  const L = LEVELS[G.li];
  const free = G.holes.filter(h => !h.occupied);
  if (!free.length) return;

  const h = free[(Math.random() * free.length) | 0];
  let kind = "mole";
  const roll = Math.random();
  if (L.bombs && roll < 0.16) kind = "bomb";
  else if (L.gold && roll < 0.28) kind = "gold";
  if (kind === "mole" && Math.random() < 0.4) kind = "prof"; // Iain mole, all levels
  // Ice mole: freezes every mole for FREEZE_SECONDS. Only on levels with
  // freezeMoles: true in config.js; never while a freeze is running, never two at once.
  if (kind === "mole" && L.freezeMoles && G.freeze <= 0 && !G.moles.some(o => o.kind === "ice" && !o.dead) &&
      Math.random() < ICE_CHANCE) kind = "ice";

  const m = {
    hole: h,
    kind,
    life: L.life * (kind === "gold" ? 0.8 : 1.0) * (0.85 + Math.random() * 0.3),
    age: 0,
    state: "rise",
    pop: 0,
    dwell: 0,
    dead: false
  };

  h.occupied = m;
  G.moles.push(m);
  if (kind !== "bomb" && kind !== "ice") G.totalShown++;   // bombs and ice moles are not targets
}

function hit(m) {
  const L = LEVELS[G.li];

  if (m.kind === "bomb") {
    G.score = Math.max(0, G.score - 15);
    G.streak = 1;
    Audio_.bomb();
    G.fx.push({
      type: "burst",
      x: m.hole.x,
      y: m.hole.y,
      t: 0,
      col: "#FF4D3D",
      text: "−15"
    });
    shake = 0.35;
  } else {
    const base = m.kind === "prof" ? 50 : m.kind === "gold" ? 30 : m.kind === "ice" ? 20 : 10;
    const pts = base * G.streak;
    G.score += pts;
    if (m.kind !== "ice") {   // ice moles are a bonus: they don't count toward the target
      G.hitsThisLevel++;
      G.totalHits++;
    }
    G.streak = Math.min(8, G.streak + 1);
    G.bestStreak = Math.max(G.bestStreak, G.streak);

    if (m.kind === "ice") { Audio_.freeze(); G.freeze = FREEZE_SECONDS; }
    else if (m.kind === "prof") Audio_.prof();
    else if (m.kind === "gold") Audio_.gold();
    else Audio_.whack();

    G.fx.push({
      type: "burst",
      x: m.hole.x,
      y: m.hole.y,
      t: 0,
      col: m.kind === "ice" ? "#8FE3FF" : m.kind === "prof" ? "#7FD3FF" : m.kind === "gold" ? "#FFB020" : "#9BE86B",
      text: m.kind === "ice" ? "+" + pts + " FREEZE!" : m.kind === "prof" ? "+" + pts + " IAIN!" : "+" + pts
    });
  }

  m.dead = true;
  m.state = "hit";
  if (G.hitsThisLevel >= L.target) levelComplete();
}

function levelComplete() {
  hideCountdown();
  if (G.li >= LEVELS.length - 1) {
    endRun("You cleared every level");
    return;
  }
  G.phase = "levelup";
  Audio_.level();
  Audio_.alarmOff();
  const dz = document.getElementById("dz");
  if (dz) dz.classList.remove("on");

  const nx = LEVELS[G.li + 1];
  const lvBig = document.getElementById("lvBig");
  const lvName = document.getElementById("lvName");
  const lvDesc = document.getElementById("lvDesc");

  if (lvBig) lvBig.textContent = nx.n;
  if (lvName) lvName.textContent = nx.name;
  if (lvDesc) lvDesc.textContent = nx.desc;

  showOverlay("#ovLevel");
}

function endRun(title) {
  hideCountdown();
  G.phase = "over";
  Audio_.over();
  Audio_.alarmOff();
  const dz = document.getElementById("dz");
  if (dz) dz.classList.remove("on");

  const endTitle = document.getElementById("endTitle");
  const endScore = document.getElementById("endScore");
  const endStats = document.getElementById("endStats");

  if (endTitle) endTitle.textContent = title;
  if (endScore) endScore.textContent = G.score;

  const acc = G.totalShown ? Math.round((100 * G.totalHits) / G.totalShown) : 0;
  if (endStats) {
    endStats.textContent = `Level ${LEVELS[G.li].n} · ${G.totalHits} whacked · ${acc}% of moles caught · best streak ×${G.bestStreak}`;
  }

  showOverlay("#ovEnd");
  recordRun();
}

function showOverlay(sel) {
  ["#ovStart", "#ovLevel", "#ovEnd", "#ovPause", "#ovSetup"].forEach(s => {
    const el = document.querySelector(s);
    if (el) el.hidden = s !== sel;
  });
}

function hideAllOverlays() {
  ["#ovStart", "#ovLevel", "#ovEnd", "#ovPause", "#ovSetup"].forEach(s => {
    const el = document.querySelector(s);
    if (el) el.hidden = true;
  });
}


/* ------------------------------------------------------------------ *
 * Scoreboard: persistent history + name entry.
 * Stored in localStorage (this browser). Newest entry is last.
 * Everything is built from JS, so no index.html change is needed.
 * ------------------------------------------------------------------ */
const Scores = {
  KEY: "molefield.scores",
  NAME_KEY: "molefield.lastname",
  KEEP_BETWEEN_RUNS: false,   // false: scores reset every time the game is launched (new tab).
                              // true: scores are kept for good in this browser.
  MAX: 5,              // how many scores the scoreboard keeps
  list: [],
  lastSaved: null,     // entry saved at the end of the most recent run
  flash: 0,            // seconds left of the "new high score" glow on the panel

  store() {
    // sessionStorage lives only as long as the tab: a fresh launch starts empty,
    // but a page refresh keeps the scores.
    try { return this.KEEP_BETWEEN_RUNS ? localStorage : sessionStorage; } catch (e) { return localStorage; }
  },
  load() {
    try {
      const a = JSON.parse(this.store().getItem(this.KEY) || "[]");
      this.list = Array.isArray(a) ? a.filter(e => e && typeof e.score === "number") : [];
      this.list = this.top(this.MAX);
    } catch (e) { this.list = []; }
  },
  persist() {
    try { this.store().setItem(this.KEY, JSON.stringify(this.list.slice(-this.MAX))); } catch (e) {}
  },
  best() { return this.list.reduce((m, e) => Math.max(m, e.score), 0); },
  top(n) {
    // highest score first; on a tie the earlier run keeps the higher rank
    return this.list.map((e, i) => ({ e, i }))
      .sort((a, b) => b.e.score - a.e.score || a.i - b.i)
      .slice(0, n).map(x => x.e);
  },
  lastName() { try { return localStorage.getItem(this.NAME_KEY) || ""; } catch (e) { return ""; } },
  add(name, run) {
    name = (name || "").trim().slice(0, 14) || "Anonymous";
    try { localStorage.setItem(this.NAME_KEY, name === "Anonymous" ? "" : name); } catch (e) {}
    const entry = {
      name, score: run.score, level: run.level, hits: run.hits,
      acc: run.acc, streak: run.streak, t: Date.now(),
    };
    const wasHigh = entry.score > this.best();
    this.list.push(entry);
    this.list = this.top(this.MAX);   // keep only the best MAX scores
    this.persist();
    this.lastSaved = entry;
    if (wasHigh) this.flash = 4;
    return wasHigh;
  },
  clear() { this.list = []; this.lastSaved = null; this.persist(); },

  /* Name prompt shown on top of the end screen. */
  ask(run) {
    const old = document.getElementById("scoreAsk");
    if (old) old.remove();
    const isHigh = run.score > this.best();

    const wrap = document.createElement("div");
    wrap.id = "scoreAsk";
    wrap.style.cssText =
      "position:fixed;left:50%;bottom:6%;transform:translateX(-50%);z-index:9999;" +
      "background:#10161d;border:1px solid " + (isHigh ? "#FFB020" : "rgba(255,255,255,.2)") + ";" +
      "border-radius:14px;padding:16px 18px;display:flex;flex-direction:column;gap:10px;" +
      "font:600 14px 'Bahnschrift','DIN Alternate',sans-serif;color:#fff;" +
      "box-shadow:0 10px 40px rgba(0,0,0,.6);min-width:280px;";
    wrap.innerHTML =
      '<div style="color:' + (isHigh ? "#FFB020" : "#9BE86B") + ';font-size:16px;">' +
      (isHigh ? "★ NEW HIGH SCORE: " + run.score : "Score: " + run.score) + "</div>" +
      '<div style="color:#9aa7b4;font-weight:500;">Enter your name for the scoreboard</div>' +
      '<input id="scoreName" maxlength="14" autocomplete="off" placeholder="Your name" ' +
      'style="padding:9px 11px;border-radius:8px;border:1px solid rgba(255,255,255,.25);' +
      'background:#0b0f14;color:#fff;font:inherit;outline:none;">' +
      '<div style="display:flex;gap:8px;">' +
      '<button id="scoreSave" style="flex:1;padding:9px;border:0;border-radius:8px;background:#9BE86B;color:#0b0f14;font:inherit;cursor:pointer;">Save</button>' +
      '<button id="scoreSkip" style="padding:9px 14px;border:1px solid rgba(255,255,255,.25);border-radius:8px;background:none;color:#fff;font:inherit;cursor:pointer;">Skip</button>' +
      "</div>";
    document.body.appendChild(wrap);

    const input = wrap.querySelector("#scoreName");
    input.value = this.lastName();
    setTimeout(() => { input.focus(); input.select(); }, 30);

    let done = false;
    const finish = (name) => {
      if (done) return;
      done = true;
      this.add(name, run);
      wrap.remove();
    };
    // keep typing from triggering game shortcuts (space/P/etc.)
    ["keydown", "keyup", "keypress"].forEach(ev =>
      input.addEventListener(ev, e => {
        e.stopPropagation();
        if (ev === "keydown" && e.key === "Enter") finish(input.value);
      }));
    wrap.querySelector("#scoreSave").onclick = () => finish(input.value);
    wrap.querySelector("#scoreSkip").onclick = () => finish("");
  },
};
Scores.load();

/* Offer the name prompt whenever a run ends with a score. */
function recordRun() {
  if (!G.score || G.score <= 0) return;
  const acc = G.totalShown ? Math.round((100 * G.totalHits) / G.totalShown) : 0;
  Scores.ask({
    score: G.score, level: LEVELS[G.li].n, hits: G.totalHits, acc, streak: G.bestStreak,
  });
}
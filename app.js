"use strict";

const MAX_DAYS = 500;
const TICK_MS = 760; // slower run rate so journal movement is easier to read on phones.
const JOURNAL_RENDER_EVERY_DAYS = 2; // reduces jerky rebuilds while simulation runs.
const ACTIONS = ["gather", "move", "rest", "socialize", "observe"];
const RUN_ID = "AIF-" + new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");

// Requested behavior tuning.
const HUNGER_THIRST_DRIVE_MULTIPLIER = 1.20;
const MEMORY_DECAY_RATE = 0.63; // Resource pass: +10% memory retention; memory loss is now 1.008/day instead of 1.12/day.
const RESOURCE_REGEN_MULTIPLIER = 1.518; // Resource pass: +20% water/general resource regeneration from the previous 1.265 setting.
const RESOURCE_CAP = 200; // Balance pass: doubled island food/water storage cap from 100 to 200.
const FOOD_REGEN_MULTIPLIER = RESOURCE_REGEN_MULTIPLIER * 2; // Resource pass: food remains 2x general regen, so the new RESOURCE_REGEN_MULTIPLIER gives food +20% too.
const RIVER_WATER_BENEFIT = 1.15; // Slightly higher normal river benefit.
const DROUGHT_RIVER_BUFF = 1.65; // Larger river-adjacent buff during drought.
const RESPAWN_WAIT_DAYS = 5; // Death cooldown: each agent stays inactive for 5 full days before returning.
const SOCIAL_COMPENSATION_BONUS = 5; // Balance pass: +5 social cushion per agent to offset easier food access.
const DAYS_PER_SIM_YEAR = 365; // Calendar scale for rare long-cycle events.
const BOUNTIFUL_HARVEST_INTERVAL_DAYS = 25 * DAYS_PER_SIM_YEAR; // Rare event: about once every 25 simulated years.
const BOUNTIFUL_HARVEST_VARIANCE = 0.15; // "or so": next harvest varies by +/-15%.
const BOUNTIFUL_HARVEST_DURATION_DAYS = 2; // Two simulation clicks/ticks.
const BOUNTIFUL_HARVEST_HEALTH_BONUS = 5; // Active agents gain +5 health on each harvest tick.

const JOURNAL_STOP_WORDS = new Set([
  "about","after","again","agent","before","being","became","because","begins","between","choosing","compared","could","darker","decision","did","does","first","from","gathered","island","journal","language","memory","notebook","pattern","river","signs","still","that","the","their","there","this","through","today","water","with","without","yesterday","maya","pollock","rembrandt","nereid","halimede","laomedeia","psamathe","neso","triton","proteus","larissa","hippocamp"
]);
const JOURNAL_CYCLE_DAYS = 3;

const state = { day: 1, running: true, timer: null, islands: [], dailyLog: [], rollingLog: [], lastJournalRenderDay: 0, bountifulHarvestDaysRemaining: 0, nextBountifulHarvestDay: 1 };
const uiState = { journalHistoryOpen: false, qDriveOpen: new Set() };

const islandNames = ["Nereid", "Halimede", "Sao", "Laomedeia", "Psamathe", "Neso", "Triton", "Proteus", "Larissa", "Hippocamp"];
const islandTemperaments = ["cautious", "curious", "social", "risk", "patient", "forager", "wanderer", "riverwise", "stoic", "adaptive"];
const agentTemplates = [
  { name: "Maya", temperament: "risk", bias: { move: 0.85, observe: 0.28 }, exploration: 0.28 },
  { name: "Pollock", temperament: "cautious", bias: { rest: 0.55, observe: 0.42 }, exploration: 0.13 },
  { name: "Rembrandt", temperament: "social", bias: { socialize: 1.05, observe: 0.25 }, exploration: 0.18 }
];

const els = {
  runState: document.getElementById("runState"),
  pauseBtn: document.getElementById("pauseBtn"),
  journalPauseBtn: document.getElementById("journalPauseBtn"),
  resetBtn: document.getElementById("resetBtn"),
  dayText: document.getElementById("dayText"),
  runSummary: document.getElementById("runSummary"),
  progressFill: document.getElementById("progressFill"),
  journalGrid: document.getElementById("journalGrid"),
  qGrid: document.getElementById("qGrid"),
  logCount: document.getElementById("logCount"),
  dailyRecordCount: document.getElementById("dailyRecordCount"),
  rollingRecordCount: document.getElementById("rollingRecordCount"),
  exportRunId: document.getElementById("exportRunId"),
  downloadJsonBtn: document.getElementById("downloadJsonBtn"),
  downloadCsvBtn: document.getElementById("downloadCsvBtn"),
  qDriveGrid: document.getElementById("qDriveGrid")
};

function clamp(value, min, max){ return Math.max(min, Math.min(max, value)); }
function round(value, digits = 0){ const factor = 10 ** digits; return Math.round(value * factor) / factor; }
function choice(list){ return list[Math.floor(Math.random() * list.length)]; }
function average(list, key){ return list.length ? list.reduce((sum, item) => sum + (Number(item[key]) || 0), 0) / list.length : 0; }
function countTrue(list, key){ return list.reduce((total, item) => total + (item[key] ? 1 : 0), 0); }
function currentLifeAge(agent, day = state.day){ return Math.max(1, day - (agent.birthDay || 1) + 1); }
function makeQ(){ return Object.fromEntries(ACTIONS.map(action => [action, 0])); }
function makeQDrive(){ return Object.fromEntries(ACTIONS.map(action => [action, 0])); }

function makeAgent(template, island){
  const q = {};
  return {
    name: template.name, temperament: template.temperament, bias: template.bias, baseExploration: template.exploration,
    health: 100, hunger: 82, thirst: 82, sleep: 80, social: 70 + SOCIAL_COMPENSATION_BONUS + Math.random() * 18,
    memory: 32 + Math.random() * 20, confidence: 4, rewardStreak: 0, deaths: 0,
    alive: true, respawnDaysRemaining: 0,
    birthDay: state.day, longestLife: 0, lastLifeDelta: 0,
    actionCounts: Object.fromEntries(ACTIONS.map(action => [action, 0])), q, qDrive: makeQDrive(), lastAction: "observe", lastBest: "observe",
    stableBestDays: 0, journal: [], lastJournalText: "", lastJournalRepeats: 1,
    daily: [], totalReward: 0, qShiftToday: 0, discoveries: 0, islandLetter: island.letter
  };
}

function makeIsland(index){
  const letter = String.fromCharCode(65 + index);
  const island = {
    letter, name: islandNames[index], temperament: islandTemperaments[index], dayAge: 1,
    food: 58 + Math.random() * 24, water: 54 + Math.random() * 28,
    fertility: 0.72 + Math.random() * 0.24, aquifer: 0.68 + Math.random() * 0.28,
    riverNear: Math.random() > 0.24, riverAffinity: index === 7 ? 1.25 : 0.9 + Math.random() * 0.35,
    drought: false, droughtDays: 0, agents: []
  };
  island.agents = agentTemplates.map(template => makeAgent(template, island));
  return island;
}

function scheduleNextBountifulHarvest(fromDay = state.day){
  const variance = 1 + ((Math.random() * 2 - 1) * BOUNTIFUL_HARVEST_VARIANCE);
  state.nextBountifulHarvestDay = fromDay + Math.max(1, Math.round(BOUNTIFUL_HARVEST_INTERVAL_DAYS * variance));
}

function startBountifulHarvest(){
  state.bountifulHarvestDaysRemaining = BOUNTIFUL_HARVEST_DURATION_DAYS;
  scheduleNextBountifulHarvest(state.day);
  for(const island of state.islands){
    for(const agent of island.agents){
      addJournal(agent, `${agent.name}: Bountiful harvest begins. The body gets a brief health cushion.`);
    }
  }
}

function updateBountifulHarvestCycle(){
  if(state.bountifulHarvestDaysRemaining <= 0 && state.day >= state.nextBountifulHarvestDay){
    startBountifulHarvest();
  }
}

function applyBountifulHarvest(agent){
  if(state.bountifulHarvestDaysRemaining <= 0 || agent.alive === false) return false;
  agent.health = clamp(agent.health + BOUNTIFUL_HARVEST_HEALTH_BONUS, 0, 100);
  return true;
}

function finishBountifulHarvestDay(){
  if(state.bountifulHarvestDaysRemaining <= 0) return;
  state.bountifulHarvestDaysRemaining -= 1;
  if(state.bountifulHarvestDaysRemaining === 0){
    for(const island of state.islands){
      for(const agent of island.agents){
        addJournal(agent, `${agent.name}: The bountiful harvest fades after ${BOUNTIFUL_HARVEST_DURATION_DAYS} ticks.`);
      }
    }
  }
}

function resetSimulation(){
  state.day = 1;
  state.running = true;
  state.islands = Array.from({length: 10}, (_, index) => makeIsland(index));
  state.dailyLog = [];
  state.rollingLog = [];
  state.lastJournalRenderDay = 0;
  uiState.qDriveOpen.clear();
  state.bountifulHarvestDaysRemaining = 0;
  scheduleNextBountifulHarvest(1);
  for(const island of state.islands){
    for(const agent of island.agents){
      addJournal(agent, `${agent.name}: I open the first notebook page and listen to ${island.name} Island before choosing.`);
    }
  }
  startTimer();
  render(true);
}

function stateBucket(island, agent){
  const need = Math.min(agent.hunger, agent.thirst, agent.sleep, agent.social);
  const resource = (island.food + island.water) / 2;
  const drought = island.drought ? "D" : "W";
  const confidence = agent.confidence > 35 ? "C" : agent.confidence > 15 ? "M" : "U";
  return [Math.floor(agent.health / 25), Math.floor(need / 20), Math.floor(resource / 25), island.riverNear ? "R" : "N", drought, confidence].join("|");
}

function ensureQState(island, agent){
  const key = stateBucket(island, agent);
  if(!agent.q[key]) agent.q[key] = makeQ();
  return key;
}

function actionScores(island, agent, qKey){
  const q = agent.q[qKey];
  const thirstNeed = (100 - agent.thirst) * HUNGER_THIRST_DRIVE_MULTIPLIER;
  const hungerNeed = (100 - agent.hunger) * HUNGER_THIRST_DRIVE_MULTIPLIER;
  const riverBonus = island.riverNear ? (island.drought ? DROUGHT_RIVER_BUFF : RIVER_WATER_BENEFIT) * island.riverAffinity : 0;
  const drive = agent.qDrive || makeQDrive();
  return {
    gather: q.gather + hungerNeed * 0.045 + thirstNeed * 0.038 + island.food * 0.012 + island.water * 0.01 + riverBonus + (agent.bias.gather || 0) + drive.gather,
    move: q.move + (100 - agent.memory) * 0.018 + (island.drought ? 0.9 : 0) + (agent.bias.move || 0) + drive.move,
    rest: q.rest + (100 - agent.sleep) * 0.055 + (100 - agent.health) * 0.025 + (agent.bias.rest || 0) + drive.rest,
    socialize: q.socialize + (100 - agent.social) * 0.06 + (agent.bias.socialize || 0) + drive.socialize,
    observe: q.observe + (100 - agent.confidence) * 0.035 + agent.memory * 0.012 + (agent.bias.observe || 0) + drive.observe
  };
}

function chooseAction(island, agent){
  const qKey = ensureQState(island, agent);
  const scores = actionScores(island, agent, qKey);
  let exploration = agent.baseExploration;
  exploration += agent.confidence < 15 ? 0.08 : 0;
  exploration = clamp(exploration - agent.stableBestDays * 0.004, 0.06, 0.34);
  if(Math.random() < exploration) return {action: choice(ACTIONS), qKey, scores, explored: true};
  const action = ACTIONS.reduce((best, current) => scores[current] > scores[best] ? current : best, ACTIONS[0]);
  return {action, qKey, scores, explored: false};
}

function decayAndRegenerateIsland(island){
  island.dayAge += 1;
  if(Math.random() < 0.012 && !island.drought){
    island.drought = true;
    island.droughtDays = 5 + Math.floor(Math.random() * 8);
    for(const agent of island.agents) addJournal(agent, `${agent.name}: Drought begins. I mark the river rule darker in memory.`);
  }
  if(island.drought){
    island.droughtDays -= 1;
    if(island.droughtDays <= 0){
      island.drought = false;
      for(const agent of island.agents) addJournal(agent, `${agent.name}: The dry spell breaks. I keep the river path in my plan.`);
    }
  }
  const droughtPenalty = island.drought ? 0.5875 : 1; // Balance pass: drought resource penalty reduced by 25% from the original 55% loss.
  const riverRegenBuff = island.riverNear ? (island.drought ? DROUGHT_RIVER_BUFF : RIVER_WATER_BENEFIT) * island.riverAffinity : 1;
  island.food = clamp(island.food + island.fertility * FOOD_REGEN_MULTIPLIER * droughtPenalty, 0, RESOURCE_CAP);
  island.water = clamp(island.water + island.aquifer * RESOURCE_REGEN_MULTIPLIER * riverRegenBuff * droughtPenalty, 0, RESOURCE_CAP);
}

function decayAgent(agent){
  agent.hunger = clamp(agent.hunger - (2.6 * HUNGER_THIRST_DRIVE_MULTIPLIER), 0, 100);
  agent.thirst = clamp(agent.thirst - (3.05 * HUNGER_THIRST_DRIVE_MULTIPLIER), 0, 100);
  agent.sleep = clamp(agent.sleep - 2.25, 0, 100);
  agent.social = clamp(agent.social - 1.55, 0, 100);
  agent.memory = clamp(agent.memory - (1.6 * MEMORY_DECAY_RATE), 0, 100);
}

function putAgentIntoRespawn(agent){
  agent.alive = false;
  agent.respawnDaysRemaining = RESPAWN_WAIT_DAYS;
  agent.health = 0;
  agent.hunger = 0;
  agent.thirst = 0;
  agent.sleep = 0;
  agent.social = 0;
  agent.lastAction = "respawning";
}

function reviveAgent(agent){
  agent.alive = true;
  agent.respawnDaysRemaining = 0;
  agent.birthDay = state.day;
  agent.health = 84;
  agent.hunger = 70;
  agent.thirst = 70;
  agent.sleep = 76;
  agent.social = 62 + SOCIAL_COMPENSATION_BONUS;
  agent.lastAction = "observe";
  addJournal(agent, `${agent.name}: Respawn complete after ${RESPAWN_WAIT_DAYS} quiet days. I begin again with warning marks intact.`);
}

function handleRespawnWait(agent){
  if(agent.alive) return false;
  if(agent.respawnDaysRemaining > 0){
    agent.respawnDaysRemaining -= 1;
    agent.lastAction = "respawning";
    return true;
  }
  reviveAgent(agent);
  return false;
}

function performAction(island, agent, action, explored){
  let reward = -0.25;
  let signal = "";
  const waterBenefit = island.riverNear ? (island.drought ? 13 * DROUGHT_RIVER_BUFF : 9 * RIVER_WATER_BENEFIT) * island.riverAffinity : 0;

  if(action === "gather"){
    const foodGain = Math.min(island.food, 8.5 + Math.random() * 6 + agent.memory * 0.022);
    const waterGain = Math.min(island.water, 5.8 + Math.random() * 5 + waterBenefit * 0.24);
    island.food = clamp(island.food - foodGain * 0.74, 0, RESOURCE_CAP);
    island.water = clamp(island.water - waterGain * 0.66, 0, RESOURCE_CAP);
    agent.hunger = clamp(agent.hunger + foodGain, 0, 100);
    agent.thirst = clamp(agent.thirst + waterGain + waterBenefit * 0.12, 0, 100);
    reward += foodGain * 0.13 + waterGain * 0.15;
    signal = island.drought && island.riverNear ? `${agent.name}: I gathered near river shade; drought water still answered.` : `${agent.name}: I gathered and compared the result to yesterday's route.`;
  }
  if(action === "move"){
    const foundResource = Math.random() < (0.24 + (100 - agent.memory) * 0.0025 + (agent.name === "Maya" ? 0.08 : 0));
    agent.memory = clamp(agent.memory + (foundResource ? 8 : 3), 0, 100);
    agent.confidence = clamp(agent.confidence + (foundResource ? 4 : 1), 0, 100);
    if(foundResource){
      island.food = clamp(island.food + 9, 0, RESOURCE_CAP);
      island.water = clamp(island.water + (island.riverNear ? 12 : 6), 0, RESOURCE_CAP);
      agent.discoveries += 1;
      reward += 2.6;
      signal = `${agent.name}: I changed paths and found a better supply sign.`;
    }else{
      reward += 0.4;
      signal = `${agent.name}: I moved to test the edge of my remembered map.`;
    }
  }
  if(action === "rest"){
    agent.sleep = clamp(agent.sleep + 18, 0, 100);
    agent.health = clamp(agent.health + 5.5, 0, 100);
    reward += (100 - agent.sleep) * 0.025 + 1.1;
    signal = `${agent.name}: I rested before the body forced the decision for me.`;
  }
  if(action === "socialize"){
    const peer = choice(island.agents.filter(other => other !== agent));
    const clueGain = Math.max(1, Math.round(peer.memory / 18));
    agent.social = clamp(agent.social + 19.2, 0, 100);
    agent.memory = clamp(agent.memory + clueGain, 0, 100);
    agent.confidence = clamp(agent.confidence + clueGain * 0.8, 0, 100);
    peer.social = clamp(peer.social + 3.6, 0, 100);
    reward += 1.7388 + clueGain * 0.18144; // Resource pass: +20% social reward from the previous setting.
    signal = `${agent.name}: I traded signs with ${peer.name}; language became a map clue.`;
  }
  if(action === "observe"){
    agent.memory = clamp(agent.memory + 5.5, 0, 100);
    agent.confidence = clamp(agent.confidence + 5, 0, 100);
    reward += agent.confidence > 55 ? 0.5 : 1.6;
    signal = `${agent.name}: I watched first. The pattern is starting to separate from noise.`;
  }

  const needPressure = (100 - agent.hunger) + (100 - agent.thirst) + (100 - agent.sleep) + (100 - agent.social);
  if(agent.hunger < 18 || agent.thirst < 18){
    agent.health = clamp(agent.health - 10.5, 0, 100);
    reward -= 4.6; // Survival-first pass: stronger penalty when core survival needs are critical.
  }else if(needPressure < 95){
    agent.health = clamp(agent.health + 1.4, 0, 100);
    reward += 1.0; // Survival-first pass: stronger reward for keeping the body stable.
  }

  const survivalFloor = Math.min(agent.health, agent.hunger, agent.thirst);
  if(survivalFloor >= 45){
    reward += 0.9; // Survival-first pass: stable survival should dominate long-term learning.
  }else if(survivalFloor < 30){
    reward -= 1.8; // Survival-first pass: teaches agents to correct danger earlier.
  }
  if(agent.health <= 0){
    const lifeDelta = currentLifeAge(agent, state.day);
    agent.longestLife = Math.max(agent.longestLife || 0, lifeDelta);
    agent.lastLifeDelta = lifeDelta;
    agent.birthDay = state.day;
    agent.deaths += 1;
    reward -= 12; // Survival-first pass: death is now the strongest negative learning signal.
    addJournal(agent, `${agent.name}: The notebook stopped. I will be absent for ${RESPAWN_WAIT_DAYS} days before a new copy begins.`);
    agent.memory = clamp(agent.memory * 0.66, 0, 100);
    agent.confidence = clamp(agent.confidence * 0.7, 0, 100);
    putAgentIntoRespawn(agent);
  }
  if(explored) signal = `${agent.name}: Experiment — ` + signal.replace(`${agent.name}: `, "");
  return {reward, signal};
}

function updateQ(island, agent, qKey, action, reward){
  const alpha = 0.12, gamma = 0.90, q = agent.q[qKey];
  const oldValue = q[action];
  const futureKey = ensureQState(island, agent);
  const futureBest = Math.max(...ACTIONS.map(next => agent.q[futureKey][next]));
  q[action] = oldValue + alpha * (reward + gamma * futureBest - oldValue);
  agent.qShiftToday += Math.abs(q[action] - oldValue);
  agent.totalReward += reward;
  agent.rewardStreak = reward > 0 ? agent.rewardStreak + 1 : 0;
}

function addJournal(agent, text){
  const normalized = text.trim();
  if(!normalized) return;
  if(agent.lastJournalText === normalized){
    agent.lastJournalRepeats += 1;
    const last = agent.journal[agent.journal.length - 1];
    if(last) last.repeats = agent.lastJournalRepeats;
    return;
  }
  agent.lastJournalText = normalized;
  agent.lastJournalRepeats = 1;
  agent.journal.push({day: state.day, agent: agent.name, text: normalized, repeats: 1});
  if(agent.journal.length > 72) agent.journal.shift();
}

function journalFromLearning(island, agent, reward, signal){
  const best = bestAction(island, agent).action;
  const changedMind = best !== agent.lastBest;
  const fragments = [];
  if(changedMind) fragments.push(`${agent.name}: My strongest value moved from ${agent.lastBest} to ${best}.`);
  if(agent.rewardStreak >= 5) fragments.push(`${agent.name}: Repeating success is becoming a habit, not luck.`);
  if(island.drought && island.riverNear) fragments.push(`${agent.name}: Drought makes the river memory louder than the field memory.`);
  if(agent.memory > 72 && agent.confidence > 58) fragments.push(`${agent.name}: The island feels smaller because memory now predicts it.`);
  if(reward < -2) fragments.push(`${agent.name}: Pain corrected the plan faster than curiosity did.`);
  if(fragments.length && Math.random() < 0.58) addJournal(agent, fragments.join(" "));
  else if(Math.random() < 0.34) addJournal(agent, signal);
  agent.lastBest = best;
}

function bestAction(island, agent){
  const qKey = ensureQState(island, agent);
  const scores = actionScores(island, agent, qKey);
  const action = ACTIONS.reduce((best, current) => scores[current] > scores[best] ? current : best, ACTIONS[0]);
  return {action, scores};
}

function qSpreadFor(agent){
  const qValues = Object.values(agent.q).filter(row => row && typeof row === "object").flatMap(row => ACTIONS.map(actionName => Number(row[actionName]) || 0));
  return qValues.length ? Math.max(...qValues) - Math.min(...qValues) : 0;
}

function dailyRecord(island, agent, action, reward){
  const actionTotal = Object.values(agent.actionCounts).reduce((a,b) => a + b, 0) || 1;
  const qSpread = qSpreadFor(agent);
  const best = bestAction(island, agent).action;
  if(best === agent.lastBest) agent.stableBestDays += 1;
  else agent.stableBestDays = 0;
  return {
    runId: RUN_ID, day: state.day, island: island.letter, name: island.name, islandTemperament: island.temperament,
    agent: agent.name, agentTemperament: agent.temperament, action, bestAction: best, reward: round(reward, 3),
    qDriveGather: round((agent.qDrive?.gather || 0), 2), qDriveMove: round((agent.qDrive?.move || 0), 2), qDriveRest: round((agent.qDrive?.rest || 0), 2), qDriveSocialize: round((agent.qDrive?.socialize || 0), 2), qDriveObserve: round((agent.qDrive?.observe || 0), 2),
    alive: agent.alive !== false, respawnDaysRemaining: agent.respawnDaysRemaining || 0,
    bountifulHarvestActive: state.bountifulHarvestDaysRemaining > 0, bountifulHarvestDaysRemaining: state.bountifulHarvestDaysRemaining, nextBountifulHarvestDay: state.nextBountifulHarvestDay,
    health: round(agent.health, 1), hunger: round(agent.hunger, 1), thirst: round(agent.thirst, 1), sleep: round(agent.sleep, 1), social: round(agent.social, 1),
    food: round(island.food, 1), water: round(island.water, 1), memory: round(agent.memory, 1), confidence: round(agent.confidence, 1),
    qSpread: round(qSpread, 3), qShift: round(agent.qShiftToday, 3), stableBestDays: agent.stableBestDays,
    discoveries: agent.discoveries, drought: island.drought, deaths: agent.deaths,
    currentLifeAge: currentLifeAge(agent, state.day), longestLife: Math.max(agent.longestLife || 0, currentLifeAge(agent, state.day)), lastLifeDelta: agent.lastLifeDelta || 0,
    actionDiversity: round(Object.values(agent.actionCounts).filter(v => v > 0).length / ACTIONS.length, 2),
    dominantActionShare: round(Math.max(...Object.values(agent.actionCounts)) / actionTotal, 2)
  };
}

function rollingRecord(island){
  const window = state.dailyLog.filter(row => row.island === island.letter && row.day > state.day - 3);
  const counts = {};
  for(const row of window) counts[row.bestAction] = (counts[row.bestAction] || 0) + 1;
  const bestAction3Day = Object.entries(counts).sort((a,b) => b[1] - a[1])[0]?.[0] || "observe";
  const deathsTotal = island.agents.reduce((total, agent) => total + agent.deaths, 0);
  const discoveriesTotal = island.agents.reduce((total, agent) => total + agent.discoveries, 0);
  return {
    runId: RUN_ID, day: state.day, island: island.letter,
    avgReward3Day: round(average(window, "reward"), 3), avgHealth3Day: round(average(window, "health"), 1),
    avgNeed3Day: round((average(window, "hunger") + average(window, "thirst") + average(window, "sleep") + average(window, "social")) / 4, 1),
    avgMemory3Day: round(average(window, "memory"), 1), avgConfidence3Day: round(average(window, "confidence"), 1),
    avgQSpread3Day: round(average(window, "qSpread"), 3), avgQShift3Day: round(average(window, "qShift"), 3),
    avgActionDiversity3Day: round(average(window, "actionDiversity"), 2), avgDominantActionShare3Day: round(average(window, "dominantActionShare"), 2),
    bountifulHarvestActive: state.bountifulHarvestDaysRemaining > 0, nextBountifulHarvestDay: state.nextBountifulHarvestDay,
    bestAction3Day, droughtDays3Day: countTrue(window, "drought"), deathsTotal, discoveriesTotal
  };
}

function simulateDay(){
  if(state.day > MAX_DAYS){ state.running = false; stopTimer(); render(true); return; }
  updateBountifulHarvestCycle();
  for(const island of state.islands){
    decayAndRegenerateIsland(island);
    for(const agent of island.agents){
      agent.qShiftToday = 0;
      if(handleRespawnWait(agent)){
        const record = dailyRecord(island, agent, "respawning", 0);
        agent.daily.push(record);
        state.dailyLog.push(record);
        continue;
      }
      applyBountifulHarvest(agent);
      decayAgent(agent);
      const decision = chooseAction(island, agent);
      const {reward, signal} = performAction(island, agent, decision.action, decision.explored);
      agent.actionCounts[decision.action] += 1;
      updateQ(island, agent, decision.qKey, decision.action, reward);
      agent.lastAction = decision.action;
      agent.confidence = clamp(agent.confidence + Math.max(-1.6, reward * 0.38), 0, 100);
      journalFromLearning(island, agent, reward, signal);
      const record = dailyRecord(island, agent, decision.action, reward);
      agent.daily.push(record);
      state.dailyLog.push(record);
    }
    state.rollingLog.push(rollingRecord(island));
  }
  finishBountifulHarvestDay();
  state.day += 1;
  if(state.day > MAX_DAYS){ state.running = false; stopTimer(); }
  render(false);
}

function render(forceJournal = false){
  const shownDay = Math.min(state.day, MAX_DAYS);
  els.runState.textContent = state.running ? "RUNNING" : (state.day > MAX_DAYS ? "COMPLETE" : "PAUSED");
  els.pauseBtn.textContent = state.running ? "Pause" : "Play";
  if(els.journalPauseBtn) els.journalPauseBtn.textContent = state.running ? "Pause Feed" : "Resume Feed";
  els.dayText.textContent = `Day ${shownDay} / ${MAX_DAYS}`;
  els.progressFill.style.width = `${Math.min(100, (shownDay / MAX_DAYS) * 100)}%`;
  const deaths = state.islands.reduce((total, island) => total + island.agents.reduce((n, agent) => n + agent.deaths, 0), 0);
  const allAgents = state.islands.flatMap(island => island.agents);
  const respawning = allAgents.filter(agent => agent.alive === false).length;
  const longestLife = allAgents.reduce((best, agent) => Math.max(best, agent.longestLife || 0, currentLifeAge(agent, shownDay)), 0);
  const avgConfidence = round(allAgents.reduce((total, agent) => total + agent.confidence, 0) / allAgents.length, 1);
  const harvestStatus = state.bountifulHarvestDaysRemaining > 0 ? `harvest active ${state.bountifulHarvestDaysRemaining}` : `next harvest D${state.nextBountifulHarvestDay}`;
  els.runSummary.textContent = `Run ${RUN_ID} • islands 10 • agents 30 • deaths ${deaths} • respawning ${respawning} • ${harvestStatus} • longest life ${longestLife} days • average confidence ${avgConfidence}%`;
  if(els.exportRunId) els.exportRunId.textContent = RUN_ID;
  if(els.dailyRecordCount) els.dailyRecordCount.textContent = state.dailyLog.length.toLocaleString();
  if(els.rollingRecordCount) els.rollingRecordCount.textContent = state.rollingLog.length.toLocaleString();
  els.logCount.textContent = `${state.dailyLog.length.toLocaleString()} daily • ${state.rollingLog.length.toLocaleString()} rolling`;
  if(forceJournal || !state.running || state.day - state.lastJournalRenderDay >= JOURNAL_RENDER_EVERY_DAYS){
    renderJournals();
    state.lastJournalRenderDay = state.day;
  }
  renderQOverview();
  renderQDriveControls();
}

function mergedJournalEntries(island){
  return island.agents.flatMap(agent => agent.journal).sort((a,b) => (a.day - b.day) || a.agent.localeCompare(b.agent)).slice(-28);
}

function islandAverages(island){
  const roll = state.rollingLog.filter(row => row.island === island.letter).slice(-1)[0] || rollingRecord(island);
  const agentBestCounts = {};
  let qSpreadNow = 0;
  let qShiftNow = 0;
  for(const agent of island.agents){
    const currentBest = bestAction(island, agent).action;
    agentBestCounts[currentBest] = (agentBestCounts[currentBest] || 0) + 1;
    qSpreadNow += qSpreadFor(agent);
    qShiftNow += agent.qShiftToday || 0;
  }
  const consensusAction = Object.entries(agentBestCounts).sort((a,b) => b[1] - a[1])[0]?.[0] || roll.bestAction3Day;
  return {
    roll,
    consensusAction,
    avgHealth: average(island.agents, "health"),
    avgNeed: (average(island.agents, "hunger") + average(island.agents, "thirst") + average(island.agents, "sleep") + average(island.agents, "social")) / 4,
    avgMemory: average(island.agents, "memory"),
    avgConfidence: average(island.agents, "confidence"),
    avgQSpreadNow: qSpreadNow / island.agents.length,
    avgQShiftNow: qShiftNow / island.agents.length
  };
}

function renderJournals(){
  const samples = journalSpotlightSamples();
  if(!samples.length){
    els.journalGrid.innerHTML = `<article class="journal-card spotlight-card"><p class="journal-line">Waiting for journal entries to emerge.</p></article>`;
    return;
  }
  const activeIndex = Math.floor(Math.max(0, state.day - 1) / JOURNAL_CYCLE_DAYS) % samples.length;
  const active = samples[activeIndex];
  const avg = islandAverages(active.island);
  const text = active.cleanText;
  const vocab = active.novelWords.slice(0, 8);
  const historyLabel = uiState.journalHistoryOpen ? "Hide Previous Entries" : "Show Previous Entries";
  els.journalGrid.innerHTML = `
    <article class="journal-card spotlight-card">
      <div class="journal-head spotlight-head">
        <div><span class="island-letter">${active.island.letter}</span> <span class="island-title">${active.island.name} Island</span></div>
        <span class="status-pill">ENTRY ${activeIndex + 1} / ${samples.length} • Q AVG ${round(avg.avgQSpreadNow, 2)} • ${avg.consensusAction.toUpperCase()}</span>
      </div>
      <div class="journal-avg-strip spotlight-strip">
        <span>DAY ${active.day} (${escapeHtml(active.agent)})</span><span>NOVELTY ${round(active.score, 2)}</span><span>MEM ${round(avg.avgMemory)}%</span><span>CONF ${round(avg.avgConfidence)}%</span>
      </div>
      <div class="spotlight-body">
        <p class="spotlight-entry">${highlightNovelWords(text, vocab)}${active.repeats > 1 ? ` <span class="repeat">×${active.repeats}</span>` : ""}</p>
        <div class="vocab-row" aria-label="Novel vocabulary">
          <span class="vocab-label">Novel vocabulary</span>
          ${vocab.length ? vocab.map(word => `<span class="vocab-chip novel-word-chip"><mark>${escapeHtml(word)}</mark></span>`).join("") : `<span class="vocab-chip muted-chip">low novelty</span>`}
        </div>
      </div>
    </article>
    <div class="journal-history-controls">
      <button id="journalHistoryToggle" class="journal-history-toggle" type="button" aria-expanded="${uiState.journalHistoryOpen ? "true" : "false"}" aria-controls="journalHistoryPanel">${historyLabel}</button>
    </div>
    <div id="journalHistoryPanel" class="sample-rail journal-history-panel" aria-label="Five sampled journal entries" ${uiState.journalHistoryOpen ? "" : "hidden"}>
      ${samples.map((sample, index) => `
        <div class="sample-card ${index === activeIndex ? "active" : ""}">
          <div><span class="island-letter mini-letter">${sample.island.letter}</span> <b>D${sample.day}</b> <span>(${escapeHtml(sample.agent)})</span></div>
          <p>${escapeHtml(sample.cleanText)}</p>
        </div>
      `).join("")}
    </div>`;
}
function journalSpotlightSamples(){
  const entries = allJournalEntries();
  if(!entries.length) return [];
  const documentFrequency = new Map();
  for(const entry of entries){
    const uniqueWords = new Set(tokenizeJournal(entry.cleanText));
    for(const word of uniqueWords) documentFrequency.set(word, (documentFrequency.get(word) || 0) + 1);
  }
  const totalDocs = Math.max(entries.length, 1);
  const scored = entries.map(entry => {
    const words = [...new Set(tokenizeJournal(entry.cleanText))];
    const novelWords = words
      .filter(word => (documentFrequency.get(word) || 0) <= Math.max(2, Math.ceil(totalDocs * 0.18)))
      .sort((a,b) => (documentFrequency.get(a) || 0) - (documentFrequency.get(b) || 0) || b.length - a.length)
      .slice(0, 10);
    const rarityScore = novelWords.reduce((total, word) => total + (1 / Math.max(1, documentFrequency.get(word) || 1)), 0);
    const recencyScore = Math.max(0, 1 - ((state.day - entry.day) / 80));
    return {...entry, novelWords, score: rarityScore + recencyScore};
  }).sort((a,b) => b.score - a.score || b.day - a.day);

  const picked = [];
  const usedText = new Set();
  const usedIsland = new Set();
  for(const entry of scored){
    const signature = entry.cleanText.toLowerCase();
    if(usedText.has(signature)) continue;
    if(usedIsland.has(entry.island.letter) && picked.length < 5) continue;
    picked.push(entry);
    usedText.add(signature);
    usedIsland.add(entry.island.letter);
    if(picked.length >= 5) break;
  }
  if(picked.length < 5){
    for(const entry of scored){
      const signature = entry.cleanText.toLowerCase();
      if(usedText.has(signature)) continue;
      picked.push(entry);
      usedText.add(signature);
      if(picked.length >= 5) break;
    }
  }
  return picked.slice(0, 5);
}

function allJournalEntries(){
  const entries = [];
  for(const island of state.islands){
    for(const agent of island.agents){
      for(const entry of agent.journal){
        const cleanText = entry.text.replace(`${entry.agent}: `, "").trim();
        if(!cleanText) continue;
        entries.push({...entry, cleanText, island});
      }
    }
  }
  const unique = new Map();
  for(const entry of entries.sort((a,b) => b.day - a.day)){
    const key = `${entry.island.letter}|${entry.agent}|${entry.cleanText.toLowerCase()}`;
    if(!unique.has(key)) unique.set(key, entry);
  }
  return [...unique.values()].sort((a,b) => b.day - a.day).slice(0, 140);
}

function tokenizeJournal(text){
  return String(text).toLowerCase().match(/[a-z][a-z-]{4,}/g)?.filter(word => !JOURNAL_STOP_WORDS.has(word)) || [];
}

function highlightNovelWords(text, words){
  let html = escapeHtml(text);
  for(const word of words.slice(0, 8)){
    const escaped = escapeRegExp(escapeHtml(word));
    html = html.replace(new RegExp(`\\b(${escaped})\\b`, "gi"), `<mark>$1</mark>`);
  }
  return html;
}

function escapeRegExp(value){ return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }


function agentDomId(island, agent){ return `${island.letter}-${agent.name}`.replace(/[^a-z0-9_-]/gi, ""); }
function qDriveTotal(agent){ return ACTIONS.reduce((total, action) => total + Math.abs(Number(agent.qDrive?.[action]) || 0), 0); }
function qDriveLabel(value){
  if(value > 0) return `+${round(value, 1)}`;
  return `${round(value, 1)}`;
}
function renderQDriveControls(){
  if(!els.qDriveGrid) return;
  const cards = [];
  for(const island of state.islands){
    for(const agent of island.agents){
      if(!agent.qDrive) agent.qDrive = makeQDrive();
      const id = agentDomId(island, agent);
      const best = bestAction(island, agent).action;
      const open = uiState.qDriveOpen.has(id);
      cards.push(`
        <details class="q-drive-agent-card" data-agent-id="${id}" ${open ? "open" : ""}>
          <summary class="q-drive-agent-summary">
            <span><span class="island-letter mini-letter">${island.letter}</span> <b>${escapeHtml(agent.name)}</b> <small>${escapeHtml(island.name)} • ${escapeHtml(agent.temperament)}</small></span>
            <span class="status-pill">BEST ${best.toUpperCase()} • DRIVE ${round(qDriveTotal(agent), 1)}</span>
          </summary>
          <div class="q-drive-controls" data-island="${island.letter}" data-agent="${escapeHtml(agent.name)}">
            ${ACTIONS.map(action => `
              <label class="q-drive-row">
                <span>${action}</span>
                <input type="range" min="-5" max="5" step="0.5" value="${agent.qDrive[action]}" data-q-action="${action}" aria-label="${agent.name} ${action} Q drive" />
                <b>${qDriveLabel(agent.qDrive[action])}</b>
              </label>
            `).join("")}
            <button type="button" class="q-drive-reset" data-reset-agent="${id}">Reset ${escapeHtml(agent.name)}</button>
          </div>
        </details>`);
    }
  }
  els.qDriveGrid.innerHTML = cards.join("");
}
function findAgentByDomId(id){
  for(const island of state.islands){
    for(const agent of island.agents){
      if(agentDomId(island, agent) === id) return {island, agent};
    }
  }
  return null;
}
function updateQDriveFromInput(input){
  const card = input.closest(".q-drive-agent-card");
  if(!card) return;
  const found = findAgentByDomId(card.dataset.agentId);
  if(!found) return;
  const action = input.dataset.qAction;
  if(!ACTIONS.includes(action)) return;
  found.agent.qDrive[action] = Number(input.value) || 0;
  const valueLabel = input.closest(".q-drive-row")?.querySelector("b");
  if(valueLabel) valueLabel.textContent = qDriveLabel(found.agent.qDrive[action]);
  const pill = card.querySelector(".status-pill");
  if(pill){
    const best = bestAction(found.island, found.agent).action;
    pill.textContent = `BEST ${best.toUpperCase()} • DRIVE ${round(qDriveTotal(found.agent), 1)}`;
  }
}
function resetAgentQDrive(id){
  const found = findAgentByDomId(id);
  if(!found) return;
  found.agent.qDrive = makeQDrive();
  addJournal(found.agent, `${found.agent.name}: My external Q drive controls were reset to neutral.`);
  render(true);
}
function renderQOverview(){
  els.qGrid.innerHTML = state.islands.map(island => {
    const avg = islandAverages(island);
    const roll = avg.roll;
    return `
      <article class="q-card">
        <div class="q-head">
          <div><span class="island-letter">${island.letter}</span> <span class="island-title">${island.name} Island</span></div>
          <span class="island-action">${avg.consensusAction.toUpperCase()}</span>
          <span class="status-pill">ISLAND AVG</span>
        </div>
        <div class="metric-grid">
          <div class="metric"><span>3D Reward</span><b>${roll.avgReward3Day}</b></div>
          <div class="metric"><span>3D Q Spread</span><b>${roll.avgQSpread3Day}</b></div>
          <div class="metric"><span>3D Q Shift</span><b>${roll.avgQShift3Day}</b></div>
          <div class="metric"><span>Action Share</span><b>${roll.avgDominantActionShare3Day}</b></div>
          <div class="metric"><span>Memory Avg</span><b>${round(avg.avgMemory)}%</b></div>
          <div class="metric"><span>Confidence Avg</span><b>${round(avg.avgConfidence)}%</b></div>
          <div class="metric"><span>Need Avg</span><b>${round(avg.avgNeed)}%</b></div>
          <div class="metric"><span>Deaths</span><b>${roll.deathsTotal}</b></div>
          <div class="metric wide"><span>Learning Signal</span><b>${emergenceLabel(island, roll)}</b></div>
        </div>
        <div class="bars">
          ${needBar("Food", island.food)}
          ${needBar("Water", island.water)}
          ${needBar("Health", avg.avgHealth)}
          ${needBar("Memory", avg.avgMemory)}
        </div>
      </article>`;
  }).join("");
}

function emergenceLabel(island, roll){
  if(roll.avgQSpread3Day > 4.5 && roll.avgDominantActionShare3Day > 0.48 && roll.avgReward3Day > 1) return "shared preference";
  if(roll.avgQShift3Day > 1.6 && roll.avgActionDiversity3Day > 0.55) return "active learning";
  if(island.drought && island.riverNear && roll.bestAction3Day === "gather") return "river adaptation";
  if(roll.avgConfidence3Day > 60 && roll.avgMemory3Day > 60) return "map language";
  return "watching";
}

function needBar(label, value){
  const safe = clamp(value, 0, 100);
  return `<div class="bar-row"><span>${label}</span><div class="bar-track"><div class="bar-fill" style="width:${safe}%"></div></div><b>${round(safe)}</b></div>`;
}

function escapeHtml(value){ return String(value).replace(/[&<>"]/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[char])); }
function csvEscape(value){ const text = String(value ?? ""); return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; }
function downloadText(filename, content, type){
  const blob = new Blob([content], {type});
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}
function downloadJSON(){
  const payload = {
    runId: RUN_ID, simulator: "Microsmos", maxDays: MAX_DAYS,
    tuning: { hungerThirstDriveMultiplier: HUNGER_THIRST_DRIVE_MULTIPLIER, memoryDecayRate: MEMORY_DECAY_RATE, resourceRegenMultiplier: RESOURCE_REGEN_MULTIPLIER, foodRegenMultiplier: FOOD_REGEN_MULTIPLIER, resourceCap: RESOURCE_CAP, riverWaterBenefit: RIVER_WATER_BENEFIT, droughtRiverBuff: DROUGHT_RIVER_BUFF, respawnWaitDays: RESPAWN_WAIT_DAYS, socialCompensationBonus: SOCIAL_COMPENSATION_BONUS, daysPerSimYear: DAYS_PER_SIM_YEAR, bountifulHarvestIntervalDays: BOUNTIFUL_HARVEST_INTERVAL_DAYS, bountifulHarvestVariance: BOUNTIFUL_HARVEST_VARIANCE, bountifulHarvestDurationDays: BOUNTIFUL_HARVEST_DURATION_DAYS, bountifulHarvestHealthBonus: BOUNTIFUL_HARVEST_HEALTH_BONUS, tickMs: TICK_MS, journalRenderEveryDays: JOURNAL_RENDER_EVERY_DAYS },
    bountifulHarvest: { active: state.bountifulHarvestDaysRemaining > 0, daysRemaining: state.bountifulHarvestDaysRemaining, nextDay: state.nextBountifulHarvestDay },
    islands: state.islands.map(island => ({
      letter: island.letter, name: island.name, temperament: island.temperament, drought: island.drought, food: island.food, water: island.water,
      agents: island.agents.map(agent => ({ name: agent.name, temperament: agent.temperament, alive: agent.alive !== false, respawnDaysRemaining: agent.respawnDaysRemaining || 0, deaths: agent.deaths, longestLife: Math.max(agent.longestLife || 0, currentLifeAge(agent, Math.min(state.day, MAX_DAYS))), currentLifeAge: currentLifeAge(agent, Math.min(state.day, MAX_DAYS)), lastLifeDelta: agent.lastLifeDelta || 0, discoveries: agent.discoveries, actionCounts: agent.actionCounts, qDrive: agent.qDrive || makeQDrive(), journal: agent.journal, q: agent.q }))
    })),
    dailyLog: state.dailyLog, rolling3DayLog: state.rollingLog
  };
  downloadText(`ai-farm-${RUN_ID}.json`, JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
}
function downloadCSV(rows, filename){
  if(!rows.length) return;
  const headers = Object.keys(rows[0]);
  const csv = [headers.join(","), ...rows.map(row => headers.map(header => csvEscape(row[header])).join(","))].join("\n");
  downloadText(filename, csv, "text/csv;charset=utf-8");
}
function startTimer(){ stopTimer(); state.timer = setInterval(() => { if(state.running) simulateDay(); }, TICK_MS); }
function stopTimer(){ if(state.timer){ clearInterval(state.timer); state.timer = null; } }

function toggleRunning(){
  state.running = !state.running;
  if(state.running) startTimer();
  render(true);
}

if(els.journalGrid){
  els.journalGrid.addEventListener("click", event => {
    const toggle = event.target.closest("#journalHistoryToggle");
    if(!toggle) return;
    uiState.journalHistoryOpen = !uiState.journalHistoryOpen;
    renderJournals();
  });
}


if(els.qDriveGrid){
  els.qDriveGrid.addEventListener("toggle", event => {
    const card = event.target.closest?.(".q-drive-agent-card");
    if(!card) return;
    if(card.open) uiState.qDriveOpen.add(card.dataset.agentId);
    else uiState.qDriveOpen.delete(card.dataset.agentId);
  }, true);
  els.qDriveGrid.addEventListener("input", event => {
    const input = event.target.closest('input[data-q-action]');
    if(!input) return;
    updateQDriveFromInput(input);
  });
  els.qDriveGrid.addEventListener("click", event => {
    const reset = event.target.closest(".q-drive-reset");
    if(!reset) return;
    resetAgentQDrive(reset.dataset.resetAgent);
  });
}

els.pauseBtn.addEventListener("click", toggleRunning);
if(els.journalPauseBtn) els.journalPauseBtn.addEventListener("click", toggleRunning);
els.resetBtn.addEventListener("click", () => { resetSimulation(); });
els.downloadJsonBtn.addEventListener("click", downloadJSON);
els.downloadCsvBtn.addEventListener("click", () => downloadCSV(state.dailyLog, `ai-farm-daily-${RUN_ID}.csv`));

resetSimulation();

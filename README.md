# Microsmos

Microsmos is a micro AI observatory for learning agents: a retro browser-based simulation where ten island environments run small adaptive agents and surface behavior through journals, Q-patterns, memory, stress, and divergence signals.

Each island runs as a dynamic grid-based environment where agents respond to resources, memory, drought, and social signals.

Designed by Jesse Glick, a new learner in software design and computer science. The AI model was first implemented in Jesse's earlier app **Jungle Island**. System design and direction are by Jesse Glick; all material and implementation are AI-assisted.

Free to use for educational and scientific purposes with credit.

## Model options

Microsmos can run in the original **Current Model** mode or in an optional **Agent Lexicon** mode.

### Current Model: Q + Journal Display

The current model uses Q-learning-style action values, body/resource state, memory, confidence, and personality bias to choose between gather, move, rest, socialize, and observe. Journal vocabulary is displayed as an observation layer: rare or interesting words are highlighted, but those words do not affect future actions.

### Agent Lexicon: Display Only

Display Only builds a lightweight word-condition memory from journal language and recent outcomes. It records which words appear near conditions such as drought, river proximity, low thirst, low hunger, low health, and action reward, but it does not change agent behavior.

### Agent Lexicon: Light Influence

Light Influence uses the same word-condition memory as a tiny secondary signal. It can slightly nudge action scores when a learned word pattern matches the current condition, but the Q-learning system remains the main decision engine.

## Run

Open `index.html` in a browser or publish the folder with GitHub Pages. The app loads in a ready state; press **Start** in the top controls to begin the simulation. **Reset** returns the run to Day 1 without auto-starting.

## Assets

The project includes PNG art files in the root folder so the repository can be uploaded directly:

- `microsmos-header.png`
- `neptune_moons_divider.png`
- `alien_ice_world_with_satellite_dish.png`

## Code

- `index.html`
- `style.css`
- `app.js`

© 2026 • Microsmos v0.5

## Balance pass: storage + food regen

- Food/water storage cap doubled from 100 to 200.
- Food regeneration doubled relative to the current +15% resource setting.
- Water regeneration remains at the current +15% resource setting.
- No island count or core simulation identity changes were added in this pass.


## World Conditions + Bonus Systems

### Base Q

Base Q is the core decision layer. It scores the five actions — gather, move, rest, socialize, and observe — using body state, island resources, memory, confidence, reward history, drought, river access, and personality bias. Optional overlays such as Q Drive and Agent Lexicon can nudge scores, but Base Q remains the main decision engine.

### Agent profiles

- **Maya** is the risk-taking explorer.
- **Pollock** is the cautious and observant agent.
- **Rembrandt** is the social agent.

These profiles bias decisions without fully overriding the Q system.

### Drought

Drought is a temporary island condition. During drought, resources still regenerate, but the drought penalty reduces regeneration to about **58.75%** of normal. Drought also gives the journal and lexicon stronger condition signals so the run can surface dry-spell behavior.

### Resource regeneration

Each island stores food and water up to a cap of **200**.

Food regeneration uses island fertility and the food regeneration multiplier. Water regeneration uses aquifer strength, the base resource regeneration multiplier, river access, and the drought penalty.

### River bonus

River access improves water recovery. The normal river water benefit is **1.15**. During drought, the drought river buff is **1.65**, so river islands can partially offset drought stress without making drought harmless.

### Bountiful Harvest

Bountiful Harvest is a rare long-cycle bonus event scheduled at roughly **25 simulated years**, with about **±15%** variation. It lasts **2 days** and gives living agents **+5 health** per harvest tick.

### Social compensation

Agents start with a small social cushion of **+5** so social need does not dominate the early balance while food and water are being tested.

### Respawn

After death, an agent remains inactive for **5 days** before returning. The new copy begins again, but warning-style journal history remains part of the run record.

## Agent Lexicon correction pass

Light Influence has been reduced and cleaned up.

- Semantic influence scale reduced by 50%.
- Semantic boost cap reduced from 0.35 to 0.18.
- Repeated journal-template words such as `gathered`, `result`, `route`, `starting`, `separate`, `noise`, `forced`, and `answered` are blocked.
- Condition words such as `drought`, `river`, `water`, `pain`, `warning`, `supply`, `body`, `thirst`, `hunger`, `health`, and `memory` are preferred.
- Top Words still shows only three words at a time in the UI.

The goal is to make the Agent Lexicon learn meaningful condition associations instead of repeated sentence phrasing.

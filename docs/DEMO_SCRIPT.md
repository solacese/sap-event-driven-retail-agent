# Demo script: 5 minute run of show

This is a tight, rehearsable script for Discount Bot. It gives the exact click order, the one sentence Raphael says at each step, and the two questions to ask the prospect at the end. Keep it to five minutes. No em dashes are used anywhere in this file.

The whole point: agents are only as good as the events they can see.

## Before you start

- Run `npm run dev` and open http://localhost:5173.
- Password is `solace` (env `DEMO_PASSWORD`).
- Default mode is mock broker plus auto-detected local LLM (or mock LLM), so nothing external is required.
- Leave the tab clean: no run in progress, footer counters at zero.

## Run of show

### 1. Open and login (0:00 to 0:30)

Click: open the URL, enter the password, land on the three column layout.

Say: "This is Discount Bot, a retail pricing agent that lives on a Solace event mesh, and the first thing to notice is what is missing."

### 2. Point out event-triggered, not prompt-triggered (0:30 to 1:00)

Click: nothing. Gesture at the screen. Point at the empty centre feed and the absence of any input box.

Say: "There is no chat box, because nobody prompts this agent, it wakes up when a business event lands on the mesh."

Selling point: event-triggered, not prompt-triggered.

### 3. Run Sunny weekend BBQ (1:00 to 2:00)

Click: the "Sunny weekend BBQ" scenario button in the header.

Say: "A sausage just got marked down 30 percent for the weekend, that price event hits the mesh and the agent wakes up on its own."

Watch: the avatar shifts to surprised then searching, the trigger row appears, and four signal rows resolve live in the timeline.

### 4. Narrate CACHED vs REQUESTED (2:00 to 2:45)

Click: nothing, point at the signal badges as they land.

Say: "Weather and consent are already here, labelled CACHED, because the agent subscribes to those event streams and materialises them locally, while inventory goes out as a request over the mesh, labelled REQUESTED."

Selling point: context is already there, and tools are mesh services. This is the strongest event-driven beat on the screen.

### 5. Show approval as an event round trip (2:45 to 3:30)

Click: the large Yes button in the approval block on the right rail.

Say: "When I click Yes, the UI does not fire the campaign, it publishes an approval decision event onto the mesh, and the agent reacts to that event before anything dispatches."

Watch: the `human-approval/decision` row appears in the feed first, then the agent consumes it, then the `campaign/dispatch/requested` row appears. Point out the ordering.

Selling point: human in the loop is an event, nothing auto-fires to customers.

### 6. Tool outage, the amber degrade (3:30 to 4:00)

Click: the "Tool outage" scenario button.

Say: "I have just killed the weather tool, and instead of crashing the agent times out at four seconds, marks weather unavailable, and proceeds on the remaining signals."

Watch: the amber chip on the weather signal, and the rationale that names the missing signal.

Selling point: tools are decoupled mesh services, so an outage degrades the run instead of failing it.

### 7. Consent squeeze, the GDPR beat (4:00 to 4:30)

Click: the "Consent squeeze" scenario button.

Say: "Here 1104 people bought this before but only 96 consented to marketing, and the campaign shrinks to exactly those 96, enforced in code, not just asked of the model."

Watch: the audience size, the consent basis called out, and the fact the other 1008 are never targeted.

Selling point: governance by design, consent enforced before targeting.

### 8. Storm of updates, the does-it-fire-on-everything beat (4:30 to 5:00)

Click: the "Storm of updates" scenario button.

Say: "Twelve price changes in twenty seconds, most below threshold, and the agent fires on the two that matter and suppresses the other ten with a reason."

Watch: two runs, ten dimmed suppression rows, and queueing visible.

Selling point: it does not fire on everything, thresholds and suppression are explicit and auditable.

## Two questions to ask the prospect

1. Which of your systems already emit events like these price, stock or consent changes today, and which ones would your agents want to see but cannot?
2. Where in your business does a human approval need to be an auditable event on the bus rather than a click that disappears into a log?

## Mapping to the five selling points

| Selling point (from the spec) | Where it shows up |
|---|---|
| 1. Event-triggered, not prompt-triggered | Step 2 and step 3, no chat box, scenario publishes a trigger |
| 2. Context is already there | Step 4, CACHED signals from materialised event streams |
| 3. Tools are mesh services | Step 4 REQUESTED signal, and step 6 tool outage degrade |
| 4. Human in the loop is an event | Step 5, approval request out and decision event in |
| 5. Governance by design | Step 7 consent squeeze, and step 8 suppression audit trail |

## Recovery

- If anything looks stuck, click Reset in the header, which returns the demo to a known state.
- Every run has a "replay this run" button that republishes the original trigger, useful to redo the hero scenario for a late arrival.

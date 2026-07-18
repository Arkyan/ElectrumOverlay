import streamDeck from "@elgato/streamdeck";

import { ActivateProfile } from "./actions/activate-profile";
import { ShowPanel } from "./actions/show-panel";
import { StreamStatsAction } from "./actions/stream-stats";
import { TriggerTestAlert } from "./actions/trigger-test-alert";

streamDeck.logger.setLevel("trace");

streamDeck.actions.registerAction(new TriggerTestAlert());
streamDeck.actions.registerAction(new ActivateProfile());
streamDeck.actions.registerAction(new ShowPanel());
streamDeck.actions.registerAction(new StreamStatsAction());

// Finally, connect to the Stream Deck.
streamDeck.connect();

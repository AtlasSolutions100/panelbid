// The takeoff and proposal rules live in ONE place, beside the API server, and
// are shared with the page through this file. Do not copy a rule into the
// page: import it from here, so the screen and the proposal can never disagree.
export * from "../../../api-server/src/lib/takeoffRules"
export * from "../../../api-server/src/lib/proposalRules"

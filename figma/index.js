#!/usr/bin/env node
// Entry point and facade. Code lives in figma/lib/*.js (see CONTRIBUTING.md).
const { startBridge } = require("./lib/server");
const { startOfficialSdkServer, startUniversalStdioServer } = require("./lib/stdio");
const { checkForUpdates, isNewerVersion, updateNotice } = require("./lib/update");
const { TIMEOUTS, ECONOMY, ORIGIN_ID } = require("./lib/config");
const { state } = require("./lib/state");
const { proxyToMaster, sendCommandToPlugin } = require("./lib/dispatch");
const { TOOLS, getActiveTools } = require("./lib/tools");
const { SERVER_INSTRUCTIONS } = require("./lib/instructions");
const { byteLength, shrinkToBudget } = require("./lib/shrink");
const { compressValidationError } = require("./lib/validation");
const { FONT_MEMO_PRELUDE, shieldParams, withFontMemo, stripFontMemo } = require("./lib/script-prep");
const { jobs, JOBS_MAX, readJobSnapshot, touchJob, sweepJobs, takeLate, settleCommand, findBusyJob, failCommandsOfClient } = require("./lib/jobs");
const { MCP_CLIENT, activeOutputCeiling, outputBudgetInfo, similarHint, truncationNote } = require("./lib/budget");
const { pngSize, collectImages, buildStructuredResult, captureOptions, buildErrorEnvelope, checkAgentSyntax, applyLineOffset, applyTokenBudget } = require("./lib/result");
const { buildInspectCode } = require("./lib/inspect-code");
const { WHAT_YOU_GET, CAPS_NOTE, classifyScript, resultIds, suggestInspect, pageWideScan, rewriteComponentize } = require("./lib/classify");
const { OVERLAY_LINKED, linkOverlay, linkedOverlay, unlinkCheckpoint, overlayCall, overlayPairs, overlayDone } = require("./lib/overlay");
const { READ_STATE, macroGuard, readGuard, guardRefusal, readNudge, resetReadStreak } = require("./lib/guards");
const { afterWriteOutline, postWrite } = require("./lib/post-write");
const { startJournal } = require("./lib/journal");
const { lateBlock, attachLate } = require("./lib/late");

if (require.main === module) {
  startJournal();
  startBridge();
  checkForUpdates();

  // Start either official SDK server or universal stdio engine
  if (!startOfficialSdkServer()) {
    startUniversalStdioServer();
  }
} else {
  // Pure helpers for tests (tests/token-economy.test.js); nothing is bound.
  module.exports = {
    TOOLS, SERVER_INSTRUCTIONS, ECONOMY, TIMEOUTS, CAPS_NOTE, WHAT_YOU_GET,
    shrinkToBudget, pngSize, collectImages, buildStructuredResult, captureOptions, getActiveTools,
    buildInspectCode, applyTokenBudget, byteLength, outputBudgetInfo, truncationNote, similarHint, afterWriteOutline, readNudge, classifyScript, suggestInspect, READ_STATE, postWrite, resetReadStreak, readGuard, guardRefusal, pageWideScan, macroGuard, overlayCall, overlayDone, OVERLAY_LINKED, linkOverlay, linkedOverlay, unlinkCheckpoint, resultIds, overlayPairs, withFontMemo, stripFontMemo, FONT_MEMO_PRELUDE, shieldParams, rewriteComponentize, compressValidationError, readJobSnapshot, jobs, MCP_CLIENT, activeOutputCeiling, applyLineOffset, checkAgentSyntax, buildErrorEnvelope, isNewerVersion, updateNotice,
    ORIGIN_ID, state, lateBlock, attachLate, proxyToMaster, sendCommandToPlugin, JOBS_MAX, touchJob, sweepJobs, takeLate, settleCommand, findBusyJob, failCommandsOfClient
  };
}

export { TOOLS, getTool, ruleFiles, allSinkDirs, RETIRED_SINK_DIRS, RETIRED_RULE_FILES } from './adapters/index.js';
export type { RuleFileDef, SkillSink, ToolDef } from './adapters/index.js';
export { runInit, runSync, aiSkeleton, materializeSkillSinks, contractExtensions } from './commands/init.js';
export { runDump, renderDump } from './commands/dump.js';
export { runNew, runNewSection, renderNewFile, isMemoryKind } from './commands/new.js';
export type { MemoryKind, NewSectionOptions } from './commands/new.js';
export { loadMemory, parseCurrentTask } from './core/memory.js';
export { buildFingerprint } from './core/fingerprint.js';
export type { Fingerprint, FingerprintOptions } from './core/fingerprint.js';
export { readSections, parseSections, sectionTarget, sectionFileName, SECTIONS_PATH } from './core/sections.js';
export type { CustomSection, SectionsResult } from './core/sections.js';
export { readSkillSources, parseSkillFile } from './core/skill-source.js';
export {
  CONTEXT_REMINDER_PERCENT,
  DEFAULT_LIMITS,
  holdsBaton,
  isClosed,
  newGoalRecord,
  reduce,
} from './core/goal.js';
export type {
  Baton,
  Blocker,
  CloseReason,
  DoneWhen,
  GoalBrief,
  GoalEffect,
  GoalEvent,
  GoalLimits,
  GoalRecord,
  GoalReport,
  GoalStatus,
  GoalStep,
  GoalView,
  MetricOp,
  WakeCondition,
  WakeRecord,
} from './core/goal.js';
export {
  damagedGoals,
  GOAL_BRIEF,
  GOAL_DIR,
  GOAL_RECORD,
  GOAL_REPORT,
  GOAL_TASKS,
  goalBriefPath,
  goalDir,
  goalRecordPath,
  goalReportPath,
  goalTasksPath,
  listGoalIds,
  activeGoal,
  newGoalId,
  parseBrief,
  parseDoneWhen,
  parseGoalRecord,
  readGoalBrief,
  readGoalRecord,
  serializeGoalRecord,
  writeGoalRecord,
} from './core/goal-store.js';
export { compareMetric, evaluateDoneWhen, parseChecklist, parseEvidence, readMetric } from './core/goal-eval.js';
export type { EvidenceSpec } from './core/goal-eval.js';
export {
  readGoalReportFile,
  runGoalBaton,
  runGoalCheck,
  runGoalClose,
  runGoalEvent,
  runGoalList,
  runGoalNew,
  runGoalReport,
  runGoalStatus,
  runGoalWake,
  writeGoalReportFile,
} from './commands/goal.js';
export type { GoalCliResult, GoalNewOptions, GoalWakeOptions, HostEventInput } from './commands/goal.js';
export { goalBrief, goalTasks } from './templates/goal-files.js';
export type { GoalBriefContext } from './templates/goal-files.js';
export {
  idleResponse,
  parseReportArgs,
  responseFromEffects,
} from './core/goal-host.js';
export type { GoalResponse, ParsedReport, ReportArgs } from './core/goal-host.js';
export { goalExtensionSource, GOAL_EXTENSION_HEADER, GOAL_EXTENSION_PATH } from './templates/goal-extension.js';
export type { GoalExtensionContext } from './templates/goal-extension.js';
export { syncGoalCarrier } from './commands/goal-carrier.js';
export type { GoalCarrierAction, GoalCarrierResult } from './commands/goal-carrier.js';
export { goalEnabled } from './core/config.js';
export { VERSION } from './version.js';
export type { ChecklistItem, CommandResult, DoneVerdict, EvalCheck, EvalDeps } from './core/goal-eval.js';
export { detectProject } from './core/project.js';
export type { ProjectFacts } from './core/project.js';
export { buildBootstrapPrompt } from './templates/meta-prompt.js';
export { aiContract, AI_CONTRACT, withContract, withoutContract } from './templates/contract.js';
export type { ContractExtensions, ContractRow } from './templates/contract.js';
export { SKILL_SPECS, SKILL_NAMES, skillFile } from './templates/skills.js';
export type { SkillSpec, SkillSource } from './templates/skills.js';

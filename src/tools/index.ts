import type { ToolDef } from "../types.js";
import { bridgeManifest, bridgeGet, bridgeUpdate, bridgeList, bridgeGetFrom, bridgeManifestUpdate } from "./context.js";
import { bridgeGetContract, bridgeUpdateContract, bridgePublishContract, bridgeListContracts } from "./contracts.js";
import { bridgeRegister, bridgeDiscover } from "./ecosystem.js";
import { bridgeChanges } from "./changes.js";
import { bridgeSyncSkills, bridgeInstallSkill, bridgeUninstallSkill, bridgePublishSkill } from "./skills.js";
import { bridgeSendMessage } from "./messages.js";
import { BUS_TOOLS } from "./bus.js";

/** Every hand-written tool, in the order clients list them. */
export const TOOLS: ToolDef[] = [
  bridgeManifest,
  bridgeGet,
  bridgeUpdate,
  bridgeList,
  bridgeGetFrom,
  bridgeGetContract,
  bridgeUpdateContract,
  bridgePublishContract,
  bridgeListContracts,
  bridgeRegister,
  bridgeDiscover,
  bridgeChanges,
  bridgeSyncSkills,
  bridgeInstallSkill,
  bridgeUninstallSkill,
  bridgePublishSkill,
  ...BUS_TOOLS,
  bridgeSendMessage,
  bridgeManifestUpdate,
];

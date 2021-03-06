import * as uuid from "uuid/v1"
import { DangerfileReferenceString } from "../db/index"
import { PUBLIC_API_ROOT_URL } from "../globals"

import { MSGDangerfileStarted, sendMessageToConnectionsWithAccessToInstallation } from "../api/api"
import { getTemporaryAccessTokenForInstallation } from "../api/github"
import { RunType } from "../danger/danger_run"
import { InstallationToRun, Payload } from "../danger/danger_runner"
import { getDB } from "../db/getDB"
import { GitHubInstallationSettings } from "../db/GitHubRepoSettings"
import { MongoDB } from "../db/mongo"

// import { runExternally } from "./runFromExternalHost"
import { runFromSameHost } from "./runFromSameHost"
import { createPerilSandboxAPIJWT } from "./sandbox/jwt"

/** Peril specific settings */
export interface PerilSettings extends GitHubInstallationSettings {
  /** A short-lived JWT that can be used to make API requests back to Peril */
  perilJWT: string
  /** The root address of the Peril server */
  perilAPIRoot: string
  /** The run ID for this current run, used in passing the results back */
  perilRunID: string
  /** The environment variables sent over from Peril */
  envVars: any
  /** The name of the run */
  event: string
}

// Sidenote: auth token is in  dsl.settings.github
export interface PerilRunnerBootstrapJSON {
  /** The DSL for JSON, could be a DangerDSLJSON type or the raw webhook */
  payload: Payload
  /** The reference for the initial dangerfile */
  paths: DangerfileReferenceString[]
  /** Installation number */
  installation: InstallationToRun
  /** DSL type */
  dslType: "pr" | "run"
  /** The DI'd settings on a per-peril run */
  perilSettings: PerilSettings
}

// You can fake this by doing something like:
//
// cat source/runner/fixtures/branch-push.json | sed 's/12345/'"$DANGER_GITHUB_API_TOKEN"'/' | hyper func call danger-peril-staging
//

/** This function is used inside Peril */
export const triggerSandboxDangerRun = async (
  eventName: string,
  type: RunType,
  installation: InstallationToRun,
  paths: DangerfileReferenceString[],
  payload: Payload
) => {
  const start: MSGDangerfileStarted = {
    event: eventName,
    action: "started",
    filenames: paths,
  }
  sendMessageToConnectionsWithAccessToInstallation(installation.iID, start)

  const token = await getTemporaryAccessTokenForInstallation(installation.iID)

  // Ensure that the settings are passed through correctly
  const DSL: any = payload.dsl || {}
  DSL.settings = {
    github: {
      accessToken: token,
      baseURL: undefined, // used for GH Enterprise, not supported today
      additionalHeaders: { Accept: "application/vnd.github.machine-man-preview+json" },
    },
    cliArgs: {} as any,
  }

  payload.dsl = DSL

  // Grab the installation env vars
  const envVars = await getEnvVars(installation.iID)
  const perilRunID = uuid()

  const stdOUT: PerilRunnerBootstrapJSON = {
    installation,
    payload,
    dslType: type === RunType.pr ? "pr" : "run",
    perilSettings: {
      ...installation.settings,
      perilJWT: createPerilSandboxAPIJWT(installation.iID, ["scheduleTask", "dangerfileFinished"]),
      perilAPIRoot: PUBLIC_API_ROOT_URL,
      envVars,
      perilRunID,
      event: eventName,
    },
    paths,
  }

  // await runExternally(stdOUT, eventName, installation)
  await runFromSameHost(stdOUT, eventName, installation)
}

/** Sandbox runs need their envVars to be sent from Peril to the sandbox */
const getEnvVars = async (iID: number) => {
  const db = getDB() as MongoDB
  const dbInstallation = await db.getInstallation(iID)
  return dbInstallation ? dbInstallation.envVars || {} : {}
}

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";

const exec = promisify(execFile);

interface CloudRunTarget {
  project: string;
  region: string;
  service: string;
  image: string;
}

export interface CloudRunRelease extends CloudRunTarget {
  head: string;
  revision: string;
  deployedAt: string;
}

interface ReleaseReview extends CloudRunTarget {
  token: string;
  head: string;
  account: string;
  runtimeIdentity?: string;
  serviceUid: string;
  revision: string;
}

interface Revision {
  spec?: { containers?: { image?: string }[] };
  status?: { conditions?: { type?: string; status?: string }[] };
}

interface CloudRunService {
  metadata?: { uid?: string };
  spec?: { template?: { spec?: { containers?: unknown[]; serviceAccountName?: string } } };
}

function parseTarget(input: Record<string, unknown>): CloudRunTarget {
  const field = (key: string, pattern: RegExp, error: string) => {
    const incoming = input[key];
    const value = typeof incoming === "string" ? incoming.trim() : "";
    if (!pattern.test(value)) throw new Error(error);
    return value;
  };
  return {
    project: field("project", /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, "Enter a Google Cloud project ID."),
    region: field("region", /^(?=.{1,30}$)[a-z]+(?:-[a-z0-9]+)+\d$/, "Enter a Cloud Run region such as us-central1."),
    service: field("service", /^[a-z](?:[a-z0-9-]{0,47}[a-z0-9])?$/, "Enter the name of an existing Cloud Run service."),
    image: field("image", /^(?=.{1,512}$)[a-z0-9-]+-docker\.pkg\.dev\/[a-z0-9-]+\/[a-z0-9._-]+(?:\/[a-z0-9._-]+)+@sha256:[0-9a-f]{64}$/,
      "Enter an Artifact Registry image pinned to its sha256 digest."),
  };
}

function readCloudJson<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error("Google Cloud returned an unreadable response. Check the service in the Cloud Run console.");
  }
}

async function gcloud(args: string[], signal: AbortSignal, timeout = 20_000): Promise<string> {
  try {
    return (await exec("gcloud", [...args, "--quiet"], {
      signal, timeout, maxBuffer: 1024 * 1024,
      env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: "1" },
    })).stdout.trim();
  } catch (error) {
    const failure = error as { code?: string; killed?: boolean; stderr?: string };
    if (signal.aborted || failure.killed) throw new Error("The Google Cloud request did not finish. Review the release again to check its state.");
    if (failure.code === "ENOENT") throw new Error("Install the Google Cloud CLI and sign in with gcloud auth login.");
    if (/no active account|gcloud auth login|reauthenticate|unauthenticated|invalid_grant|\b401\b/i.test(failure.stderr ?? "")) {
      throw new Error("Sign in to the Google Cloud CLI with gcloud auth login, then review the release again.");
    }
    if (/permission|forbidden|\b403\b/i.test(failure.stderr ?? "")) {
      throw new Error("Google Cloud denied access. Check the selected account’s Cloud Run, service account, and Artifact Registry permissions.");
    }
    if (/not found|does not exist|\b404\b/i.test(failure.stderr ?? "")) {
      throw new Error("Google Cloud could not find the selected resource. Check the project, region, service, and image.");
    }
    throw new Error("Google Cloud could not complete the request. Check the selected service and image in the Cloud Run console.");
  }
}

async function activeAccount(signal: AbortSignal): Promise<string> {
  const account = await gcloud(["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"], signal);
  if (!/^[^\s@]+@[^\s@]+$/.test(account)) throw new Error("Select an active Google Cloud CLI account with gcloud auth login.");
  const impersonation = await gcloud(["config", "get-value", "auth/impersonate_service_account"], signal);
  if (impersonation && impersonation !== "(unset)") throw new Error("Select a Google Cloud CLI configuration without service account impersonation.");
  const credentials = await gcloud(["config", "get-value", "auth/credential_file_override"], signal);
  if ((credentials && credentials !== "(unset)") || process.env.CLOUDSDK_AUTH_ACCESS_TOKEN || process.env.CLOUDSDK_AUTH_ACCESS_TOKEN_FILE) {
    throw new Error("Use a signed-in Google Cloud CLI configuration without credential overrides.");
  }
  return account;
}

function targetFlags(target: CloudRunTarget, account: string): string[] {
  return [`--project=${target.project}`, `--region=${target.region}`, `--account=${account}`];
}

async function serviceIdentity(target: CloudRunTarget, account: string, signal: AbortSignal) {
  const raw = await gcloud(["run", "services", "describe", target.service, ...targetFlags(target, account),
    "--format=json(metadata.uid,spec.template.spec.containers,spec.template.spec.serviceAccountName)"], signal);
  const service = readCloudJson<CloudRunService>(raw);
  const spec = service?.spec?.template?.spec;
  if (!service?.metadata?.uid || spec?.containers?.length !== 1) throw new Error("Choose an existing Cloud Run service with one container.");
  return { serviceUid: service.metadata.uid, runtimeIdentity: spec.serviceAccountName };
}

export class CloudRunReleases {
  private readonly reviews = new Map<string, { approvedUntil: number; plan: ReleaseReview }>();
  private readonly active = new Map<string, Promise<CloudRunRelease>>();

  constructor(private readonly signal: AbortSignal) {}

  async prepare(runId: string, head: string, input: Record<string, unknown>): Promise<ReleaseReview> {
    this.reviews.delete(runId);
    const target = parseTarget(input);
    const account = await activeAccount(this.signal);
    const identity = await serviceIdentity(target, account, this.signal);
    const suffix = "sy-" + createHash("sha256").update(JSON.stringify([runId, head, target])).digest("hex").slice(0, 10);
    const plan = {
      ...target, ...identity, head, account,
      revision: `${target.service}-${suffix}`, token: randomUUID(),
    };
    this.reviews.set(runId, { approvedUntil: Date.now() + 5 * 60_000, plan });
    return plan;
  }

  deploy(runId: string, head: string, token: unknown): Promise<CloudRunRelease> {
    const review = this.reviews.get(runId);
    if (!review || review.plan.head !== head || review.plan.token !== token || review.approvedUntil < Date.now()) {
      throw new Error("This release review is missing, expired, or out of date. Review the release again.");
    }
    const { plan } = review;
    const key = JSON.stringify([plan.project, plan.region, plan.service]);
    if (this.active.has(key)) throw new Error("A release is already in progress for this Cloud Run service.");
    this.reviews.delete(runId);
    const operation = this.deployReviewed(plan).finally(() => this.active.delete(key));
    this.active.set(key, operation);
    return operation;
  }

  private async deployReviewed(plan: ReleaseReview): Promise<CloudRunRelease> {
    if (await activeAccount(this.signal) !== plan.account) throw new Error("The active Google Cloud account changed. Review the release again.");
    const identity = await serviceIdentity(plan, plan.account, this.signal);
    if (identity.serviceUid !== plan.serviceUid || identity.runtimeIdentity !== plan.runtimeIdentity) {
      throw new Error("The Cloud Run service or its runtime identity changed. Review the release again.");
    }
    const flags = targetFlags(plan, plan.account);
    const findRevision = async (): Promise<Revision | undefined> => {
      const output = await gcloud(["run", "revisions", "list", ...flags, `--service=${plan.service}`,
        `--filter=metadata.name=${plan.revision}`, "--limit=1", "--format=json(spec.containers,status.conditions)"], this.signal);
      return readCloudJson<Revision[]>(output)?.[0];
    };
    let revision = await findRevision();
    if (!revision) {
      const suffix = plan.revision.slice(plan.service.length + 1);
      await gcloud(["run", "services", "update", plan.service, ...flags, `--image=${plan.image}`,
        `--revision-suffix=${suffix}`, "--no-traffic", "--format=none"], this.signal, 6 * 60_000);
      revision = await findRevision();
    }
    if (!revision || revision.spec?.containers?.[0]?.image !== plan.image ||
        !revision.status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True")) {
      throw new Error("Cloud Run has not confirmed the selected image as a ready revision. Check the revision in the Cloud Run console before retrying.");
    }
    const distribution = await gcloud(["run", "services", "describe", plan.service, ...flags,
      "--format=json(status.traffic,status.latestReadyRevisionName)"], this.signal);
    const status = readCloudJson<{ status?: { latestReadyRevisionName?: string; traffic?: {
      percent?: number; revisionName?: string; latestRevision?: boolean;
    }[] } }>(distribution)?.status;
    if (!Array.isArray(status?.traffic) || status.traffic.some((entry) => (entry.percent ?? 0) > 0 &&
        (entry.revisionName ?? (entry.latestRevision ? status.latestReadyRevisionName : undefined)) === plan.revision)) {
      throw new Error("Cloud Run did not confirm that the new revision receives zero traffic. Check the service in the Cloud Run console.");
    }
    const { project, region, service, image, head } = plan;
    return { project, region, service, image, head, revision: plan.revision, deployedAt: new Date().toISOString() };
  }

  async shutdown(): Promise<void> {
    this.reviews.clear();
    await Promise.allSettled(this.active.values());
  }
}

import { randomBytes } from "node:crypto";
import YAML from "yaml";
import type { DeploymentWorkflow, WorkflowDeploymentProvider } from "../config.ts";
import { git } from "../exec.ts";
import { draftBase, fetchDraftBase, githubApi, githubOrigin, inspectLinkedPullRequest } from "./publication.ts";

export interface WorkflowDeploymentReview extends DeploymentWorkflow {
  token: string;
  provider: WorkflowDeploymentProvider;
  repository: string;
  branch: string;
  head: string;
  workflowId: number;
}

export interface DeploymentWorkflowRun {
  id: number;
  url: string;
  status: string;
  conclusion?: string;
}

const apiVersion = ["--header", "X-GitHub-Api-Version: 2026-03-10"];
const githubRepoPath = (repository: string) => `repos/${new URL(repository).pathname.slice(1)}`;

export class WorkflowDeployments {
  constructor(private readonly signal: AbortSignal) {}

  async prepare(repo: string, pullRequest: string | undefined, provider: WorkflowDeploymentProvider, config: DeploymentWorkflow):
    Promise<WorkflowDeploymentReview> {
    const repository = await githubOrigin(repo);
    if (!repository || !pullRequest) throw new Error("Link a merged pull request from this repository’s GitHub origin.");
    const pr = await inspectLinkedPullRequest(repo, repository, pullRequest, this.signal);
    const { branch, head } = await draftBase(repo, repository, this.signal);
    if (pr?.state !== "merged" || pr.base !== branch || !pr.mergeCommit || !/^[a-f0-9]{40}$/.test(pr.mergeCommit)) {
      throw new Error("The linked pull request must be merged into the repository’s default branch.");
    }
    await fetchDraftBase(repo, { url: repository }, head, this.signal);
    if (!await git(["merge-base", "--is-ancestor", pr.mergeCommit, head], repo).then(() => true, () => false)) {
      throw new Error("The pull request’s merge commit is outside the current default branch history.");
    }
    const api = githubApi(repo, this.signal, 12_000);
    const path = githubRepoPath(repository);
    const get = (endpoint: string, ...args: string[]) => api(endpoint, "--method", "GET", ...args).catch(() => undefined);
    const [metadata, workflow, environment] = await Promise.all([
      get(`${path}/actions/workflows/${encodeURIComponent(config.workflow)}`, "--jq", 'select(.state == "active") | .id'),
      get(`${path}/contents/.github/workflows/${encodeURIComponent(config.workflow)}?ref=${head}`, "--header", "Accept: application/vnd.github.raw+json"),
      get(`${path}/environments/${encodeURIComponent(config.environment)}`, "--jq", ".name"),
    ]);
    const workflowId = Number(metadata);
    if (!Number.isSafeInteger(workflowId) || workflowId < 1 || !workflow) {
      throw new Error("Shipyard couldn’t read an active deployment workflow on GitHub. Check the workflow filename and GitHub access.");
    }
    if (environment?.toLowerCase() !== config.environment.toLowerCase()) {
      throw new Error("Shipyard couldn’t read the configured GitHub Actions environment. Check that it exists and is accessible.");
    }
    validateDeploymentWorkflow(workflow);
    return { ...config, token: randomBytes(24).toString("hex"), provider, repository, branch, head, workflowId };
  }

  async dispatch(repo: string, review: WorkflowDeploymentReview, config: DeploymentWorkflow | undefined, beforeDispatch: () => void) {
    if (config?.workflow !== review.workflow || config.environment !== review.environment || await githubOrigin(repo) !== review.repository) {
      throw new Error("The deployment configuration changed. Verify it again before approving.");
    }
    const current = await draftBase(repo, review.repository, this.signal);
    if (current.branch !== review.branch || current.head !== review.head) {
      throw new Error("The default branch moved after review. Verify the latest commit before approving.");
    }
    beforeDispatch();
    const api = githubApi(repo, this.signal, 30_000);
    try {
      const receipt = JSON.parse(await api(`${githubRepoPath(review.repository)}/actions/workflows/${review.workflowId}/dispatches`,
        "--method", "POST", ...apiVersion, "-f", `ref=${review.branch}`, "-f", `inputs[commit_sha]=${review.head}`,
        "-f", `inputs[environment]=${review.environment}`, "--jq", "{workflow_run_id}")) as { workflow_run_id?: number };
      const id = receipt.workflow_run_id;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) throw new Error("Missing workflow run ID");
      return { id, url: `${review.repository}/actions/runs/${id}`, status: "queued" };
    } catch {
      throw new Error("GitHub hasn’t confirmed whether the workflow started. Check the repository’s Actions history before starting another deployment.");
    }
  }

  async status(repo: string, review: WorkflowDeploymentReview, run: DeploymentWorkflowRun): Promise<DeploymentWorkflowRun> {
    const api = githubApi(repo, this.signal, 12_000);
    const response = await api(`${githubRepoPath(review.repository)}/actions/runs/${run.id}`, "--method", "GET", ...apiVersion,
      "--jq", "{head_sha, head_branch, workflow_id, event, status, conclusion}").catch(() => undefined);
    if (!response) return run;
    const data = JSON.parse(response);
    if (data.head_sha !== review.head || data.head_branch !== review.branch || data.workflow_id !== review.workflowId || data.event !== "workflow_dispatch") {
      return { ...run, status: "completed", conclusion: "reviewed commit or workflow did not match" };
    }
    return { ...run, status: typeof data.status === "string" ? data.status : run.status,
      conclusion: typeof data.conclusion === "string" ? data.conclusion : undefined };
  }
}

function validateDeploymentWorkflow(contents: string) {
  const workflow = YAML.parse(contents);
  const inputs = workflow?.on?.workflow_dispatch?.inputs;
  const environmentInput = inputs?.environment;
  const jobs = Object.values(workflow?.jobs ?? {}) as Array<{ if?: unknown; environment?: unknown }>;
  const environmentExpression = "${{ inputs.environment }}";
  const guard = /^\s*(?:\$\{\{\s*github\.sha\s*==\s*inputs\.commit_sha\s*\}\}|github\.sha\s*==\s*inputs\.commit_sha)\s*$/;
  const guarded = jobs.length && jobs.every((job) => typeof job?.if === "string" && guard.test(job.if));
  const boundEnvironment = jobs.some((job) => job?.environment === environmentExpression ||
    (job?.environment as { name?: unknown } | undefined)?.name === environmentExpression);
  const extraRequired = Object.entries(inputs ?? {}).some(([name, input]) =>
    !["commit_sha", "environment"].includes(name) && (input as { required?: boolean; default?: unknown } | null)?.required === true &&
    (input as { default?: unknown }).default === undefined);
  if (inputs?.commit_sha?.required !== true || inputs.commit_sha.type !== "string" || environmentInput?.required !== true ||
      !["string", "environment"].includes(environmentInput.type) || extraRequired || !guarded || !boundEnvironment) {
    throw new Error("The workflow needs commit_sha and environment dispatch inputs, the reviewed commit guard on every job, and the selected GitHub environment on its deployment job.");
  }
}

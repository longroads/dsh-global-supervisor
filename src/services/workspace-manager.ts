/**
 * WorkspaceManager：受管项目视图（方案 §6.1）。
 * 身份与生命周期委托 DSH（经 Adapter），业务属性存 projects 表；
 * 启动对账输出双向漂移（外部新建/删除的 workspace）。
 */
import type { WorkspaceInfo } from '../adapters/dsh-workspace.js';
import { DshWorkspaceAdapter } from '../adapters/dsh-workspace.js';
import type { DatabaseSync } from 'node:sqlite';
import { ProjectRepository } from '../database/repository/project-repository.js';
import type { ProjectHealth, ProjectRow, ProjectStatus } from '../types/index.js';

/** 生成项目 ID（node:crypto 动态导入，遵守顶层零内建静态依赖纪律）。 */
async function newProjectId(): Promise<string> {
  const { randomUUID } = await import('node:crypto');
  return `proj-${randomUUID().slice(0, 8)}`;
}

/** 项目视图 = DSH workspace ⨝ 业务属性。 */
export interface ProjectView {
  projectId: string;
  workspaceId: string;
  workspacePath: string;
  title: string;
  description: string;
  priority: number;
  status: ProjectStatus;
  workerSessionId: string | null;
  health: ProjectHealth;
  sessionCount: number;
  lastReviewAt: string | null;
  nextReviewAt: string | null;
}

/** 启动对账的漂移报告。 */
export interface ReconcileReport {
  managedWorkspaces: number;
  unmanagedWorkspaces: Array<{ workspaceId: string; title: string }>;
  missingWorkspaceProjects: Array<{ projectId: string; workspaceId: string }>;
}

export class WorkspaceManager {
  readonly projects: ProjectRepository;

  constructor(private readonly adapter: DshWorkspaceAdapter, private readonly db: DatabaseSync) {
    this.projects = new ProjectRepository(db);
  }

  /** 全部受管项目（默认排除归档），⨝ workspace 实时视图。 */
  async listProjects(includeArchived = false): Promise<ProjectView[]> {
    const workspaces = await this.adapter.listWorkspaces();
    const byWorkspace = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    const rows = this.projects.list(includeArchived);
    return rows
      .filter((row) => byWorkspace.has(row.workspace_id))
      .map((row) => this.toView(row, byWorkspace.get(row.workspace_id) as WorkspaceInfo));
  }

  /** 单项目详情。 */
  async getProject(projectId: string): Promise<ProjectView | undefined> {
    const row = this.projects.byId(projectId);
    if (!row) return undefined;
    const workspace = await this.adapter.getWorkspace(row.workspace_id);
    if (!workspace) return undefined;
    return this.toView(row, workspace);
  }

  /** 按 workspace 查项目（工具入参常用 workspaceId）。 */
  async projectByWorkspace(workspaceId: string): Promise<ProjectView | undefined> {
    const row = this.projects.byWorkspaceId(workspaceId);
    if (!row) return undefined;
    const workspace = await this.adapter.getWorkspace(workspaceId);
    return workspace ? this.toView(row, workspace) : undefined;
  }

  /** 纳管既有 workspace（不重复注册，业务行幂等）。 */
  async adoptWorkspace(workspaceId: string, opts: { priority?: number; description?: string } = {}): Promise<ProjectView> {
    const workspace = await this.adapter.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`workspace 不存在：${workspaceId}`);
    const existing = this.projects.byWorkspaceId(workspaceId);
    const projectId = existing?.id ?? (await newProjectId());
    if (!existing) {
      this.projects.create({
        id: projectId,
        workspaceId,
        name: workspace.title,
        description: opts.description ?? '',
        priority: opts.priority,
      });
    }
    const view = await this.getProject(projectId);
    if (!view) throw new Error('纳管后项目不可读（内部错误）');
    return view;
  }

  /**
   * 新建项目：目录须已存在（由调用方/Router 会话的文件工具负责创建目录，
   * 插件自身不做文件系统写操作）——registry realpath 校验兜底。
   */
  async createProject(path: string, title: string, opts: { priority?: number; description?: string } = {}): Promise<ProjectView> {
    const existing = await this.adapter.resolveByPath(path);
    if (existing) throw new Error(`路径已注册为 workspace（${existing.id}），请改用纳管`);
    const workspace = await this.adapter.createWorkspace(path, title);
    const projectId = await newProjectId();
    this.projects.create({
      id: projectId,
      workspaceId: workspace.id,
      name: title,
      description: opts.description ?? '',
      priority: opts.priority,
    });
    const view = await this.getProject(projectId);
    if (!view) throw new Error('创建后项目不可读（内部错误）');
    return view;
  }

  /** 归档：仅业务状态（绝不删 DSH 注册与历史数据）。 */
  async archiveProject(projectId: string): Promise<boolean> {
    return this.projects.archive(projectId);
  }

  /** 启动对账：registry 与 projects 双向 diff。 */
  async reconcile(): Promise<ReconcileReport> {
    const workspaces = await this.adapter.listWorkspaces();
    const rows = this.projects.list(true);
    const managedIds = new Set(rows.map((row) => row.workspace_id));
    const registryIds = new Set(workspaces.map((workspace) => workspace.id));
    return {
      managedWorkspaces: managedIds.size,
      unmanagedWorkspaces: workspaces
        .filter((workspace) => !managedIds.has(workspace.id))
        .map((workspace) => ({ workspaceId: workspace.id, title: workspace.title })),
      missingWorkspaceProjects: rows
        .filter((row) => !registryIds.has(row.workspace_id))
        .map((row) => ({ projectId: row.id, workspaceId: row.workspace_id })),
    };
  }

  private toView(row: ProjectRow, workspace: WorkspaceInfo): ProjectView {
    return {
      projectId: row.id,
      workspaceId: row.workspace_id,
      workspacePath: workspace.path,
      title: row.name,
      description: row.description,
      priority: row.priority,
      status: row.status,
      workerSessionId: row.worker_session_id,
      health: row.health,
      sessionCount: workspace.sessionIds.length,
      lastReviewAt: row.last_review_at,
      nextReviewAt: row.next_review_at,
    };
  }
}

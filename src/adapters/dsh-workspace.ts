/**
 * WorkspaceRegistry 适配器：workspaceRegistry 服务的唯一触达点。
 * 返回映射后的纯数据（防 façade Proxy 深层透传），业务层不接触 DSH 实体对象。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { WorkspaceId, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import { awaitService } from './host-services.js';

/** Workspace 纯数据视图。 */
export interface WorkspaceInfo {
  id: string;
  path: string;
  title: string;
  sessionIds: readonly string[];
  createdAt: string;
  updatedAt: string;
}

export class DshWorkspaceAdapter {
  constructor(private readonly ctx: Context) {}

  private registry(): Promise<WorkspaceRegistry> {
    return awaitService<WorkspaceRegistry>(this.ctx, 'workspaceRegistry');
  }

  /** 全量 workspace（registry.list() 同步投影）。 */
  async listWorkspaces(): Promise<WorkspaceInfo[]> {
    const registry = await this.registry();
    return registry.list().map((workspace) => ({
      id: workspace.id,
      path: workspace.path,
      title: workspace.title,
      sessionIds: workspace.sessionIds,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    }));
  }

  /** 按 ID 查找（本地过滤，避免对 registry 做多余调用）。 */
  async getWorkspace(workspaceId: string): Promise<WorkspaceInfo | undefined> {
    const list = await this.listWorkspaces();
    return list.find((workspace) => workspace.id === workspaceId);
  }

  /** 注册既有目录为 workspace（目录必须已存在——registry 内部 realpath 校验）。 */
  async createWorkspace(path: string, title: string): Promise<WorkspaceInfo> {
    const registry = await this.registry();
    const workspace = await registry.create(path, title);
    return {
      id: workspace.id,
      path: workspace.path,
      title: workspace.title,
      sessionIds: workspace.sessionIds,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    };
  }

  /** 解除注册（保留目录与历史数据；归档业务语义在 WorkspaceManager 层）。 */
  async deleteWorkspace(workspaceId: string): Promise<boolean> {
    const registry = await this.registry();
    return registry.delete(workspaceId as WorkspaceId);
  }

  /** 按规范化路径查既有注册，不创建。 */
  async resolveByPath(path: string): Promise<WorkspaceInfo | undefined> {
    const registry = await this.registry();
    const workspace = await registry.resolveByPath(path);
    return workspace
      ? {
          id: workspace.id,
          path: workspace.path,
          title: workspace.title,
          sessionIds: workspace.sessionIds,
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
        }
      : undefined;
  }
}

import { ArrowRightIcon as ArrowRight } from '@phosphor-icons/react/ArrowRight'
import { FolderOpenIcon as FolderOpen } from '@phosphor-icons/react/FolderOpen'
import { ShieldCheckIcon as ShieldCheck } from '@phosphor-icons/react/ShieldCheck'

import type { DefaultExportDirectoryView, ExportTask } from '../../../shared/domain.js'
import { PathDisplay } from './PathDisplay.js'
import { WorkspaceHeading } from './WorkspaceHeading.js'

export function SettingsPage({
  task,
  defaultDirectory,
  onChooseDirectory,
}: {
  task: ExportTask
  defaultDirectory: DefaultExportDirectoryView | null
  onChooseDirectory(): void
}) {
  return (
    <div className="page-workspace settings-page">
      <WorkspaceHeading
        title="设置"
        description="调整本地导出与默认行为。敏感凭证请在“连接到 App”中管理。"
      />
      <section className="settings-group">
        <header className="settings-group-heading">
          <span className="settings-group-icon">
            <FolderOpen size={20} />
          </span>
          <div>
            <h3>本地导出</h3>
            <p>设置常用位置与文件夹分组方式。</p>
          </div>
        </header>
        <div className="settings-list">
          <button className="settings-row" type="button" onClick={onChooseDirectory}>
            <span>
              <strong>默认导出位置</strong>
              <small>
                {defaultDirectory?.path ? <PathDisplay path={defaultDirectory.path} /> : '尚未选择'}
              </small>
            </span>
            <ArrowRight size={18} />
          </button>
          <div className="settings-row">
            <span>
              <strong>默认文件夹分组</strong>
              <small>
                每组 {task.localFolder.itemsPerFolder} 张，
                {task.localFolder.format === 'original' ? '保留原格式' : '转换为 WebP'}
              </small>
            </span>
          </div>
        </div>
      </section>
      <section className="settings-group">
        <header className="settings-group-heading">
          <span className="settings-group-icon">
            <ShieldCheck size={20} />
          </span>
          <div>
            <h3>隐私与存储</h3>
            <p>查看本机数据处理与凭证管理边界。</p>
          </div>
        </header>
        <div className="settings-list">
          <div className="settings-row">
            <span>
              <strong>本地优先</strong>
              <small>素材库只保存在这台 Mac，数据处理均在本地进行</small>
            </span>
            <span className="settings-status">
              <ShieldCheck size={17} />
            </span>
          </div>
        </div>
      </section>
    </div>
  )
}

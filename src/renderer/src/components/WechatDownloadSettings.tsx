import { useId, useState } from 'react'
import { InfoIcon as Info } from '@phosphor-icons/react/Info'
import { XIcon as X } from '@phosphor-icons/react/X'

import type { WechatDownloadMode } from '../../../shared/domain.js'
import { MenuSelect } from './MenuSelect.js'

const SPEED_OPTIONS: Array<{ value: WechatDownloadMode; label: string }> = [
  { value: 'default', label: '默认速度' },
  { value: 'fast', label: '快速获取' },
  { value: 'safe', label: '安全获取' },
]

export function WechatDownloadSettings({
  value,
  disabled,
  cacheFirst = false,
  onChange,
}: {
  value: WechatDownloadMode
  disabled: boolean
  cacheFirst?: boolean
  onChange(value: WechatDownloadMode): void
}) {
  const [showInfo, setShowInfo] = useState(false)
  const infoId = useId()

  return (
    <>
      <div className="wechat-download-settings">
        <label>下载速度</label>
        <div>
          <MenuSelect
            value={value}
            options={SPEED_OPTIONS}
            ariaLabel="选择微信素材下载速度"
            disabled={disabled}
            onChange={onChange}
          />
          <button
            type="button"
            className="wechat-speed-info-button"
            aria-label="查看下载速度说明"
            aria-expanded={showInfo}
            aria-controls={infoId}
            onClick={() => setShowInfo(true)}
          >
            <Info size={17} />
          </button>
        </div>
      </div>

      {showInfo && (
        <aside id={infoId} className="wechat-speed-info" role="note">
          <div>
            <strong>下载速率说明</strong>
            <p>
              {cacheFirst
                ? '速度设置仅影响本机缺失素材的微信 CDN 获取，本机缓存读取不受影响。微信没有公开此接口的频率阈值。'
                : '微信没有公开此接口的频率阈值。降低请求频率只能减少风险，不能保证不会触发服务端限制。'}
            </p>
          </div>
          <button
            type="button"
            className="panel-close"
            onClick={() => setShowInfo(false)}
            aria-label="关闭下载速度说明"
          >
            <X size={15} />
          </button>
          <dl>
            <div>
              <dt>默认速度</dt>
              <dd>{cacheFirst ? '使用标准并发解析缺失素材' : '单并发，每张间隔随机 0.5-1.5 秒'}</dd>
            </div>
            <div>
              <dt>快速获取</dt>
              <dd>
                {cacheFirst
                  ? '提高 CDN 并发，适合网络稳定时'
                  : '4 并发连续下载，适合少量图片或网络稳定时'}
              </dd>
            </div>
            <div>
              <dt>安全获取</dt>
              <dd>
                {cacheFirst ? '串行解析缺失素材，速度较慢' : '单并发，每张间隔随机 1.5-3.5 秒'}
              </dd>
            </div>
          </dl>
        </aside>
      )}
    </>
  )
}

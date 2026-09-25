import type { ChangeType } from '../types/report';
import { changeTypeSignal } from '../lib/changes';
import { useT } from '../lib/i18n';

/**
 * 文件变更类型角标(v1.1 可选字段,老报告没有这个字段)。
 *
 * 注意语义:changeType 描述的是**文件**,不是符号 —— 文件被修改时,其中新增的
 * 符号也会标成「修改」。所以角标只用来提示「这个文件动了什么」,不承担
 * 「这个符号被删了」的断言;真正判断符号自身是否消失,要看 impact。
 *
 * 已删除 = 高信号(紫,列表里唯一使用该色的地方)。当前引擎版本因为
 * 「被删除的文件不产生 diff hunk」而不会产出 removed,但契约里有,所以照常渲染。
 * 新增 = 中性虚线框(还没被人依赖)。
 * 修改 = 不渲染:变更集里绝大多数是修改,给常态也加角标只会淹没高信号。
 */
export function ChangeTypeTag({ type }: { type: ChangeType | undefined }) {
  const t = useT();
  const signal = changeTypeSignal(type);
  if (!type || signal === 'none') return null;
  return (
    <span
      className={`ctag ctag--${signal}`}
      data-change-type={type}
      title={`${t('detail.changeType')}:${t(`changeType.${type}`)}`}
    >
      {t(`changeType.${type}`)}
    </span>
  );
}

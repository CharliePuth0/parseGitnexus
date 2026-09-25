import { useI18n } from '../lib/i18n';
import { DocIcon } from './icons';

/** 顶部条:产品标识 + 全局动作(语言、重新载入)。刻意压到 44px,把高度留给内容。 */
export function AppHeader({ hasReport, onReload }: { hasReport: boolean; onReload: () => void }) {
  const { t, locale, setLocale } = useI18n();
  return (
    <header className="appbar">
      <div className="appbar__brand">
        <span className="appbar__mark" aria-hidden="true">
          GN
        </span>
        <span className="appbar__title">{t('app.title')}</span>
        <span className="appbar__sub">{t('app.subtitle')}</span>
      </div>
      <div className="appbar__spacer" />
      {hasReport ? (
        <button type="button" className="btn btn--ghost btn--sm" onClick={onReload}>
          <DocIcon />
          {t('app.reload')}
        </button>
      ) : null}
      <button
        type="button"
        className="btn btn--ghost btn--sm appbar__lang"
        onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}
        title={locale === 'zh' ? 'Switch to English' : '切换到中文'}
      >
        {t('app.langSwitch')}
      </button>
    </header>
  );
}

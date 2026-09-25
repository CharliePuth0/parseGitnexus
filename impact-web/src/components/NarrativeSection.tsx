import Markdown from 'react-markdown';
import type { LlmSection } from '../types/report';
import { useT } from '../lib/i18n';
import { InfoIcon } from './icons';

/**
 * LLM 叙事(markdown)。为空时不留白:直接告诉评审者报告缺什么、怎么补。
 */
export function NarrativeSection({ llm }: { llm: LlmSection }) {
  const t = useT();
  const narrative = (llm.narrative ?? '').trim();

  return (
    <div className="narrative">
      {narrative === '' ? (
        <>
          <div className="notice notice--info">
            <InfoIcon className="notice__icon" />
            <div>
              <div>{t('llm.empty')}</div>
              <div className="narrative__hint">{t('llm.emptyHint')}</div>
            </div>
          </div>
          {llm.prompt ? (
            <details className="disclosure narrative__prompt">
              <summary>
                {t('llm.promptIncluded')}
                <span className="panel__count tnum">{llm.prompt.length}</span>
              </summary>
              <pre className="narrative__promptBody">{llm.prompt}</pre>
            </details>
          ) : null}
        </>
      ) : (
        <>
          <div className="md">
            <Markdown>{narrative}</Markdown>
          </div>
          {llm.prompt ? (
            <details className="disclosure narrative__prompt">
              <summary>{t('llm.promptIncluded')}</summary>
              <pre className="narrative__promptBody">{llm.prompt}</pre>
            </details>
          ) : null}
        </>
      )}
    </div>
  );
}

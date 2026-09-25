import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../lib/i18n';
import { UploadIcon, WarningIcon } from './icons';
import './upload.css';

/**
 * 空状态:整个页面就是投放区。v1 只读本地文件,不直连 serve API。
 */
export function UploadScreen({
  onLoad,
  onLoadSample,
  error,
}: {
  onLoad: (text: string, label: string) => void;
  onLoadSample: () => void;
  error: string | null;
}) {
  const t = useT();
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  // 拖到窗口任意位置都不该被浏览器接管(否则会跳走打开文件)
  useEffect(() => {
    const prevent = (event: DragEvent) => event.preventDefault();
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  const readFile = useCallback(
    async (file: File) => {
      try {
        const text = await file.text();
        onLoad(text, file.name);
      } catch (err) {
        onLoad('', `${file.name}:${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [onLoad],
  );

  return (
    <div
      className={`upload${dragging ? ' upload--dragging' : ''}`}
      onDragEnter={(event) => {
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        const file = event.dataTransfer.files?.[0];
        if (file) void readFile(file);
      }}
    >
      <div className="upload__card">
        <div className="upload__brand">
          <span className="upload__mark" aria-hidden="true">
            GN
          </span>
          <div>
            <h1 className="upload__title">{t('app.title')}</h1>
            <p className="upload__subtitle">{t('app.subtitle')}</p>
          </div>
        </div>

        <div className="upload__zone">
          <UploadIcon className="upload__icon" />
          <p className="upload__drop">{dragging ? t('upload.dropActive') : t('upload.drop')}</p>
          <p className="upload__hint">{t('upload.desc')}</p>
          <div className="upload__actions">
            <button type="button" className="btn btn--primary" onClick={() => inputRef.current?.click()}>
              {t('upload.choose')}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                onLoadSample();
              }}
            >
              {t('upload.sample')}
            </button>
          </div>
          <p className="upload__sampleHint">{t('upload.sampleHint')}</p>
          <p className="upload__structure mono">{t('upload.structure')}</p>
        </div>

        {error ? (
          <div className="notice upload__error" role="alert">
            <WarningIcon className="notice__icon" />
            <div>
              <strong>{t('upload.errorTitle')}</strong>
              <div className="mono upload__errorText">{error}</div>
            </div>
          </div>
        ) : null}

        <input
          ref={inputRef}
          type="file"
          accept="application/json,.json"
          className="visually-hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void readFile(file);
            event.target.value = '';
          }}
        />
      </div>
    </div>
  );
}

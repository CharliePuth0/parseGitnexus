import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
/* 样式加载顺序 = 打包后的层叠顺序:vendor → 令牌 → 组件(App 及其子组件)。
   React Flow 的颜色走 tokens.css 里的 --xy-* 桥接,不依赖这里的顺序;
   这里保证的是「自有规则永远排在 vendor 之后」,避免同权重被覆盖。 */
import '@xyflow/react/dist/style.css';
import './styles/tokens.css';
import App from './App';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

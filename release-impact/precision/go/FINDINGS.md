# Go precision verification — FINDINGS(摘要)

完整裁决见代理报告(已归档于会话记录);本文件保留关键结论供检索。

## Verdicts

| gate | result |
| --- | --- |
| Fixture gate(15 个 Go 样例,controls-only) | **PASS** — 35/35 recall 100%,precision 94.6%,5/5 guard 边,0 方向错 |
| Fixture flows(informational) | recall 84.0% — 12/12 漏报全部是 D2(块粒度行号) |
| **Prometheus 真实代码 gate** | **FAIL** — 26→27 期望(含 1 个标注遗漏修正),检索到 20,7 个"漏报" |

## 核心结论

**7 个漏报不是推导缺陷:27/27 守卫边都存在于持久化 CDG 中且方向正确(原始 cypher 验证)——
坏的是检索通路,而且是静默失效:**

1. `pdg_query` schema 不接受 line/functionLine/symbol/target_uid(信封拒绝)
2. UID 含 `/` → `looksLikeFilePath`(local-backend.ts:282)判为文件路径 → 静默空结果(D6/D7,Java 同样存在)
3. 文件路径兜底分页按**字符串序** srcId `ORDER BY srcId … LIMIT 200`、无 offset → 大文件里行号小的函数不可达(`labelNames` @884 在 813 行文件中不可查询)

## Go 特有缺陷(相对 Java 分类)

- **G1** defer 实参捕获倒置(假边)
- **G2** defer/go 字面量双重建模且不链接(静默欠报——named return 被 defer 覆盖不可见)
- **G3** goroutine/闭包捕获对外围锚点不可见
- **G4** `guard:true` 假阳性:isGuardExit 纯文本测试,不看取臂(收尾 return 被标 guard)
- **G5** 循环携带/自边是真实边(消费方不得全量过滤 [F])
- **G6** 符号锚点是行窗口,混入嵌套单元行(必须按 functionLine 过滤)
- **G7** >2000 行函数静默跳过(无 CFG)

## 建议

- 守卫/CDG 推导在 Go 上可信(27/27)——**默认开启的前置条件是修检索层**:
  ① looksLikeFilePath 先识别 UID 形状;② pdg_query 加分页 offset 或 line/target_uid 参数(数字排序);③ isGuardExit 校验取臂。
- flows 在 Go 上暂不上(84% + G1/G2/G3 静默欠报)。
- 前端必须把"0 行结果"当 UNKNOWN 展示,永不显示为"无守卫"。

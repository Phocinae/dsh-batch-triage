# dsh-batch-triage 架构

## 一句话

规则先跑，覆盖每一条；规则放不下的，变成 `needs_review` 并说明原因 ——
**永远不会被当成 routine。**

## 数据流

```
  一批 items（1..64）
        │
        ▼
  validateItems ────────────► 用法/配置错误（exit 2 / 3，在任何 IO 之前）
        │
        ▼
  逐条 prefilter
        │
        ├── 字段覆盖命中？（severity / security / data_loss / reporter_tier）
        │        └── 命中 → 直接定级（字段强于正文）
        │
        ├── 正文为空？ ─────────────────► undecided（EMPTY_TEXT）
        │
        ├── 规则按序匹配，第一个命中即用 ─► urgent / needs_review / routine
        │
        └── 一条都不命中 ───────────────► undecided（NO_RULE_MATCHED）
                │
                └── 残差 = 唯一会请模型的地方
                      ├── 没配模型     → needs_review / unavailable
                      ├── 预算为 0     → needs_review / budget
                      └── 配了但未实现 → needs_review / unavailable（并如实说明）
        │
        ▼
  summarise（counts / urgentIds / escalatedIds / decidedBy / skippedModel）
        │
        ▼
  deriveExit ──► exitCode 的阶梯（lib/exit.mjs 一处实现）
```

## 为什么这样切

### 规则是主路径，模型是兜底

一个工单批次不适合「一条一次模型调用」：量大、有意思的少，
而且**不管需不需要，每条都要一个来回**。所以顺序被反过来写：
规则先覆盖全部，只有残差才可能进模型。

这不是优化，是设计本身 —— 它改变了这个工具是什么：
**prefilter 是产品，模型是给残差用的备胎。**

### 字段强于正文

填过表的人已经告诉你了。`severity: critical` 不该被正文里的一句问号推翻，
所以字段覆盖在任何文本规则之前判定。

### 首个命中即用，而不是「最具体者胜」

打分制需要一套没人能辩护的权重；**一个有文档的顺序是可检查的**，
而一条永不命中的规则是一个**看得见的** bug。

urgent 规则排在最前是有意的：一个既报告故障、又写成疑问句的工单，
不能被疑问句规则吞掉 —— 这条有测试。

## 从结构上杜绝的那件事

> **一条 item 只有在规则说了的情况下才是 `routine`。**

四条「判不了」的路径，**全部**汇入 `needs_review`：

| 情形 | class | decidedBy | reason |
|---|---|---|---|
| 正文为空 | `needs_review` | `unavailable` | `EMPTY_TEXT` + `MODEL_NOT_CONFIGURED` |
| 没有规则命中 | `needs_review` | `unavailable` | `NO_RULE_MATCHED` + `MODEL_NOT_CONFIGURED` |
| 预算被拒 | `needs_review` | `budget` | `BUDGET_EXHAUSTED` |
| 模型层未实现 | `needs_review` | `unavailable` | `MODEL_TIER_NOT_IMPLEMENTED` |

把「我判不了」变成「没什么可看的」，是这个工具存在的唯一理由所要防的事。
测试在两个方向都钉住了它（正向：判不了必须 needs_review；反向：规则命中时必须不是）。

## 退出码阶梯

八种码，一次运行可能同时满足多个条件，所以**优先级只在一个地方实现**
（`lib/exit.mjs` 的 `exitCode()`），并且以**数据**形式导出（`EXIT_PRIORITY`），
让读者不必读代码就能看到顺序：

```
2 用法 → 3 配置 → 4 空扫描 → 7 零预算 →
6 模型不可用 → 5 断言失败 → 1 有发现 → 0 干净
```

**阶梯是完整的优先级顺序，不是可观测码的完整清单。** 本批次运行器只可能产出
`0 / 1 / 2 / 3 / 6`；另外三档没有生产者：

| 档 | 没有生产者的原因 |
|---|---|
| `4` 空扫描 | `validateItems` 在任何条目被扫描之前就把空批次按用法错误拒了（exit 2），所以 `decided === 0` 到不了 |
| `5` 断言失败 | 本版没有 `expect` API；这一档是被保留并写在文档里的，不是被发明的 |
| `7` 零预算 | `modelStateCap: 0` 在加载时抛（见下表），所以 `config.modelStateCap === 0` 不成立 |

这三档仍然留 `exitCode()` 里，因为它是**导出**的：宿主可以直接构造 facts。
留一个文档写明「谁能到达它」的档，比留一个读者以为可达的档要好。

两条排序是判断，值得写下来：

- **用法错误高于一切。** 一次从未合法的运行不可能发现了任何东西，
  报「有发现」就是在说谎。
- **覆盖缺口高于发现。** `6` 说的是「这次运行没能覆盖它需要覆盖的全部」，
  比 `1` 的「其中一部分要人看」更强，而且是**超集** ——
  对 `6` 做出反应的调用者会去看，并在 summary 里看到那条 urgent。

**第二条的隐患**是只看退出码的调用者会以为批次没问题。
所以 summary **永远**列出 `urgentIds` 与 `escalatedIds`，
并且有一条测试专门断言：在覆盖缺口存在时，urgent 条目仍然出现在 summary 里。

## 失败方向

| 情形 | 结果 |
|---|---|
| 未识别的退出码条件键 | **抛** `TRIAGE_BAD_EXIT_FACT`（exit 2）—— 静默忽略可能丢掉的正是那个本该非零的条件 |
| 空批次 | exit 2（用法），**不是**「没有发现」，也不是阶梯上的 `4` |
| 超过 64 条 | exit 2，**拒绝而非截断** |
| `id` 重复 | exit 3 —— id 是答案的键，合并会丢工单且无法分辨 |
| `modelStateCap: 0` | **加载即抛**（exit 2）—— 它同一次调用里既要求模型覆盖又禁止它 |
| `tau` 越界 | 加载即抛，不静默 clamp |
| 未实现的模型层 | `needs_review` + 如实说明，**不假装跑过** |
| 工具层的非法入参 | 返回结构化拒绝（`exitBasis: "refused"`，空 summary），**不抛** —— 宿主 schema 子集没有 `minimum`，`modelStateCap: 0` 是 schema 合法输入 |

## 文件

| 文件 | 职责 |
|---|---|
| `index.mjs` | 组合入口：`ctx.inject` 注册工具与技能 |
| `lib/prefilter.mjs` | 字段覆盖、规则表、判定顺序、`raiseClass`（只升不降） |
| `lib/triage.mjs` | 批次运行：逐条判定、残差处理、预算、汇总、推导退出码 |
| `lib/exit.mjs` | 八码、优先级数据、`exitCode()`、`CI_ACCEPTED` |
| `lib/config.mjs` | 配置解析与批次校验（拒绝而非截断、拒绝而非合并） |
| `lib/errors.mjs` | 错误码与错误类型（闭集） |
| `lib/skill.mjs` | 由**规则表**生成的技能文本（不手写，避免漂移）—— 由 `createPlugin` 注册 |
| `skills/batch-triage/SKILL.md` | 随包发布的技能文件（**手写**，不是上一条的输出）。`createSkill()` 的 body 与它不是同一份文本，也没有一致性检查；改规则表时要手动同步这一份，否则模型看到的可能是旧描述。`verify-artifacts.mjs` 只断言它存在且会被发出去 |
| `tools.mjs` | `batch_triage` 工具定义（宿主 JSON Schema 子集内） |
| `scripts/verify-artifacts.mjs` | 发布前自检：结构 **+ 行为** —— 逐条断言每个规则**仍能命中** |

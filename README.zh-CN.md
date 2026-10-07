# dsh-openai-live

**为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供 GPT-Live-1 全双工语音能力。**

> **状态：预发布。** 所有结论均对**线上 API 实测**得出，而非依据文档。168 个测试；**逐文件 100%**
> 覆盖率门槛（强制执行，而非仅作报告）；另有一项以纯 `node` 运行**已构建产物**的冒烟测试。尚未发布至 npm。

## 为什么需要它

DeepSeek Harness 本身没有全双工语音子系统，生态中也没有任何插件实现 `gpt-live-1` —— 这是唯一的
**在售且未公布停用日期**的全双工语音模型。最接近的插件面向的是即将退役的 `gpt-realtime` 系列，
端点不同、事件词表也不同。本项目填补的正是这一空缺。

真正有意思的不是音频，而是模型可以**委派（delegation）**：对话中途抛出任务交由宿主 agent 处理，
并等待答复，同时不中断对话。把这套信封做对 —— 以及在无法答复时**失效即拒绝（fail closed）** ——
才是本项目的核心。

## 能力接缝，而非单体

三个包，与 DSH 自身对 `ctx.llm` 的建模方式一致：

| 包 | 职责 |
|---|---|
| **`dsh-realtime`** | **接缝（seam）**。注册 `realtime` 服务，掌管 provider、路由与会话生命周期。刻意不接管轮流发言、断句判定，也不提供任何委派自动应答路径。 |
| **`dsh-realtime-openai`** | **GPT-Live-1 适配器**。划分为线上类型、传输、翻译、会话类四层；其中翻译层为纯函数，并以真实录制的帧进行测试。 |
| **`dsh-realtime-replay`** | **免密钥后端**。将录制的会话回放至**真实的**适配器与会话，使一致性验证可在 CI 中运行 —— 无需凭据、无需网络、不产生费用。 |

第四个包 **`dsh-openai-live`**（本仓库根目录）是一个 bundle：提供挂载上述两行的 `cordis.patch.yml`，
并依赖全部三个包。

## 安装

```bash
dsh plugin --profile <name> add dsh-openai-live      # 发布后
dsh --profile <name> --dump-config                   # 配置能否组装成功？
dsh --profile <name> web
```

随后**通过环境变量**提供凭据 —— 它是经过校验的配置字段，本代码从不读取密钥文件：

```bash
export OPENAI_LIVE_API_KEY=…
```

即便**没有**凭据，profile 也能正常组装：路由会注册，而开启会话时会以 `MISSING_CREDENTIAL` 报错 ——
该错误**只指出缺少哪项设置，绝不回显其值**。这是刻意设计：未配置的机器应当能启动，
然后明确告知缺什么，而不是在启动时直接让 harness 崩溃。

## 受约束且有测试保障的性质

1. **委派失效即拒绝。** 无法解析或报错的委派**绝不**自动放行。
2. **轮流边界由 provider 掌管。** 不做手写 VAD；接缝直接拒绝断句调用 —— `session.input_audio.commit`
   在 API 中**根本不存在**，这一点由服务端自行枚举其词表予以确认。
3. **凭据是被测试保障的不变量，而非约定。** 凭据错误只指出设置名；任何值都不会进入日志、夹具、
   提交历史或发布产物。
4. **免密钥回放。** 完整对话路径可在无 API 密钥的情况下验证。
5. **漂移哨兵。** 定时检查，一旦上游协议变形即刻报错，使第一信号是构建失败，而不是用户反馈的缺陷。
6. **追加（append）以 provider 的确认作为完成信号**，优先按回显的 `client_event_id` 关联，
   **回退到 FIFO** —— 未写入文档的回显必须退化为顺序匹配，绝不能退化为永久挂起的 Promise。
7. **用量是累计值**，因此消费方应替换而非累加；同一个值在 `session.usage.updated` 与
   `session.closed` 上各出现一次是正常的。
8. **每个注册表都验证其清理** —— 从子 fiber 注册，销毁该 fiber，并观察到贡献确实消失。

## 对线上 API 的实测结果

`docs/` 目录是首要记录，其中每条都是实测所得，每个陷阱都曾耗费一次运行：

| 文档 | 内容 |
|---|---|
| [docs/protocol.md](docs/protocol.md) | GPT-Live-1 的 WebSocket 协议：完整的客户端与服务端词表、委派信封、音频格式，以及各处陷阱 |
| [docs/design.md](docs/design.md) | 架构、范围、会话生命周期 |
| [docs/decisions.md](docs/decisions.md) | ADR —— 为何选择客户端委派、为何采用接缝、为何本仓库不受治理流程约束 |
| [docs/w1-entitlement-probe.md](docs/w1-entitlement-probe.md) | 权限探测，以及为何余额为零并非权限问题 |
| [docs/w1-delegation-envelope.md](docs/w1-delegation-envelope.md) | 两种委派模式的实测对比 |

## 参与开发

```bash
pnpm install
pnpm gate      # 构建 → 类型检查（含 src 与 tests）→ 覆盖率门槛 → 已构建产物冒烟测试
pnpm canary    # 线上漂移检查；无 OPENAI_LIVE_API_KEY 时自动跳过
```

门槛要求 **逐文件 100%** 的语句、分支、函数与行覆盖率，通过 `perFile: true` **强制执行**，
且该强制力已被验证确实生效：注入一个未覆盖分支即会以退出码 1 报错，并指出文件与各维度。
单元测试之外，还有两层不可跳过：通过真实 Loader 启动 `cordis.yml` 的**组合测试**，
以及在纯 `node` 下运行已发布 `lib/` 的**产物冒烟测试**。

详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 安全

本仓库不存储任何凭据。`.gitignore` 在**首个受跟踪文件之前**即已提交，且 CI 会对**完整历史**进行密钥扫描 ——
因为后续提交中删除的密钥，依然已经公开。漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。

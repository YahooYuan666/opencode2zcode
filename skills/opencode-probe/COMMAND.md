---
description: 检测 OpenCode 免费模型各渠道（Chat 与 Responses）的连通性状态。实测每个模型，区分「地区受限（换节点可解）」与「本身已下架（换节点无解）」等原因，给出 S/A/B/C 档位与社区热度辅助选型。
argument-hint: "[optional model-id]"
---

# OpenCode Probe

用于快速体检 OpenCode 免费渠道的所有模型连接状态。

User arguments: $ARGUMENTS

1. 检查是否存在 `$ARGUMENTS`：
   - 若用户传入了具体模型名称（例如 `/opencode-probe exo-free`），运行带参数的探测：
     ```bash
     node D:/Projects/opencode2zcode/tools/probe-channels.mjs --model "$ARGUMENTS"
     ```
   - 若未传参数（直接运行 `/opencode-probe`），运行全量检测：
     ```bash
     node D:/Projects/opencode2zcode/tools/probe-channels.mjs
     ```

2. 遵循 `~/.zcode/skills/opencode-probe/SKILL.md` 的归因规范，向用户输出诊断报告：
   - 先给出一句话 TLDR 结论。
   - **一张表搞定**：模型 ID | 状态及核心诊断 | 上下文 | 档位 | 社区热度，按档位 S → A → B → C 排序。
   - **不报延迟**（单次测试耗时随机性太大，没有参考价值）。
   - 行动建议按档位分组，S 档里优先推荐上下文大的。

3. 汇报选型时注意口径，**不得夸大**：
   - **档位只看能不能调通，不评价模型能力。** S 闭眼用，A 换节点用，B 过阵子再试，C 别浪费时间。
   - **「社区热度」是 OpenRouter 全站真实调用量**（日榜），用的人多说明生态成熟，
     但**热度高不等于能力强**，只是第三方佐证。对不上的显示"—"，不扣分。
   - 参数相同的两个模型能力可能天差地别，不要按上下文或档位排能力高低。
   - 目录已标废弃但实测仍通的模型，说明现在能用但随时可能被撤，不建议长期依赖。

4. 给出清晰明确的行动建议。

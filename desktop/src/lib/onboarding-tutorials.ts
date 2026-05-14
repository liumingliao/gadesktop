/**
 * Tutorial content registry — hand-written fix-it snippets keyed by
 * failure cause. Surfaced via TutorialModal when the user clicks
 * "查看教程" on a failed/warning row in StepAttach or StepHealth.
 *
 * Why hand-written instead of bundling upstream Hello GA markdown:
 *   - Galley-specific context ("完成后回到这里点 选择" / "重新检查")
 *     can't live in upstream
 *   - 50-150 word focused snippets read faster than full chapter sections
 *   - Maintenance: one file in Galley vs. tracking upstream drift
 *
 * Each entry links to the corresponding Hello GA chapter for the full
 * authoritative treatment. The upstream URL is the Datawhale tutorial
 * on GitHub — anchors are unreliable across GitHub heading slug
 * generators for Chinese headings, so we link to the chapter top
 * and trust users to scroll.
 */

export type TutorialId =
  | "download-ga"
  | "wrong-directory"
  | "mykey-setup"
  | "assets-missing"
  | "memory-info";

export interface Tutorial {
  id: TutorialId;
  title: string;
  /** Markdown source. Rendered by TutorialModal via MarkdownView. */
  body: string;
  /** External URL for the full upstream tutorial. Opens in system
   * browser via target="_blank". Omit when the snippet is fully
   * self-contained (e.g. "memory-info" reassurance). */
  upstreamUrl?: string;
  /** Friendly label for the upstream link. Defaults to "查看完整教程". */
  upstreamLabel?: string;
}

const HELLO_GA_BASE =
  "https://github.com/datawhalechina/hello-generic-agent/blob/main/docs/part1/chapter1/index.md";

export const TUTORIALS: Record<TutorialId, Tutorial> = {
  "download-ga": {
    id: "download-ga",
    title: "下载 GenericAgent",
    body: `看起来还没下载 GA 的代码到本地。两种方式任选其一：

**方式一：下载 ZIP（推荐新手）**

1. 打开 [GA 仓库页面](https://github.com/lsdefine/GenericAgent)
2. 点绿色 **Code** 按钮 → **Download ZIP**
3. 解压到你喜欢的位置（例如 \`~/Documents/GenericAgent\`）

**方式二：Git Clone**

\`\`\`bash
git clone https://github.com/lsdefine/GenericAgent.git
\`\`\`

完成后回到 Galley，点 **选择** 按钮重新指向 GA 的根目录。`,
    upstreamUrl: HELLO_GA_BASE,
    upstreamLabel: "查看 §1.2 下载项目（Datawhale Hello GA）",
  },

  "wrong-directory": {
    id: "wrong-directory",
    title: "你选错了目录",
    body: `这个路径存在，但里面找不到 \`agentmain.py\`——说明它不是 GA 的安装目录。

GA 仓库根目录应该有这些文件：

- \`agentmain.py\` · 入口
- \`ga.py\` · 工具实现
- \`mykey_template.py\` · 配置模板
- \`assets/\` · 静态资源
- \`frontends/\` · 官方前端

常见错误：

- 选成了 \`frontends/\` 子目录而不是根目录
- 选成了下载的压缩包父目录而不是解压出来的 GA 文件夹
- 选成了同名但里面是别的内容的目录

回到 Galley 点 **选择**，确保选的是包含 \`agentmain.py\` 的那一层。

如果你压根没下载过 GA，先按下载教程操作。`,
    upstreamUrl: HELLO_GA_BASE,
    upstreamLabel: "查看 §1.2 下载项目（Datawhale Hello GA）",
  },

  "mykey-setup": {
    id: "mykey-setup",
    title: "配置 API 密钥（mykey.py）",
    body: `GA 需要一个 \`mykey.py\` 文件告诉它用哪个大模型、怎么连。这个文件你需要自己创建——Galley 不会替你写。

**第 1 步：复制模板**

进 GA 目录，找到 \`mykey_template.py\`，复制一份重命名为 \`mykey.py\`。

**第 2 步：填 API 信息**

用任意文本编辑器（VS Code / 记事本都行）打开 \`mykey.py\`。找到你要用的模型配置块，比如：

- \`native_claude_config0\` · Claude 系列
- \`native_oai_config\` · OpenAI 系列
- \`oai_config_deepseek\` · DeepSeek
- \`oai_config_kimi\` · Moonshot Kimi

把 \`apikey\` 和 \`apibase\` 改成你自己的。记得把这一整段最前面的 \`#\` 注释符删掉——有 \`#\` 的行不生效。

**第 3 步：保存并回到 Galley**

保存后回到这里点 **重新检查**。

> 新手推荐配置：Claude 主力 + GPT 兜底。完整渠道清单（智谱 / MiniMax / OpenRouter / 硅基流动 / 反代…）见上游教程。`,
    upstreamUrl: HELLO_GA_BASE,
    upstreamLabel: "查看 §1.4 配置 API 密钥（Datawhale Hello GA）",
  },

  "assets-missing": {
    id: "assets-missing",
    title: "GA 安装不完整",
    body: `GA 目录里缺 \`assets/\` 文件夹——这是 GA 的静态资源（图标、SOP、工具历史等），缺了它 GA 仍能跑但某些功能会报错。

通常意味着下载没下完整或解压出错。

**如果你是 ZIP 下载的：**

1. 彻底删掉当前 GA 目录
2. 重新从 [GA 仓库](https://github.com/lsdefine/GenericAgent) 下载 ZIP
3. 解压后确认 \`assets/\` 在根目录

**如果你是 git clone 的：**

\`\`\`bash
cd 你的 GA 目录
git status        # 看是否有未跟踪/丢失文件
git pull          # 拉最新
\`\`\`

完成后回到这里点 **重新检查**。`,
    upstreamUrl: HELLO_GA_BASE,
    upstreamLabel: "查看 §1.2 下载项目（Datawhale Hello GA）",
  },

  "memory-info": {
    id: "memory-info",
    title: "memory/ 会自动创建",
    body: `这个警告**可以忽略**——GA 首次启动时会自动在根目录创建 \`memory/\` 文件夹，用于存储四层记忆（L1 工作记忆 / L2 章节记忆 / L3 长期记忆 / L4 元记忆）。

只要其他检查都通过，直接 **继续** 进入 Galley 就行。GA 第一次跑起来后这个目录就在了。

> 如果你不想等，也可以手动创建（任选其一）：
>
> \`\`\`bash
> # macOS / Linux
> cd 你的 GA 目录 && mkdir memory
>
> # Windows
> cd 你的 GA 目录 && md memory
> \`\`\``,
    // No upstream URL — this is purely reassurance, not a tutorial-worthy
    // procedure. Linking would imply "go read more" when there's nothing
    // more to read.
  },
};

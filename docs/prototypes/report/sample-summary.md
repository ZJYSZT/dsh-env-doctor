体检完成：17 项检查 —— 通过 13、注意 2、失败 1、说不准 1。总体：失败
1. [高危] C.4 git 凭据助手指向的程序是否存在
   → git config --global --unset-all credential.https://github.com.helper
2. [中] D.1 执行策略是否拦 `.ps1` 脚本
   → Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
3. [低] E.3 同名命令多份安装 / 解析到意料之外
   → 把 %APPDATA%\npm 与 pnpm 的 .cmd shim 所在目录在用户级 PATH 中前置到 WindowsApps 之前
说不准：B.1（原因见报告）
全文：C:\Users\神\Documents\deepseek-harness\default-workspace\.dsh-doctor\report-20261014-171203.md

体检完成：9 项检查 —— 通过 5、注意 2、失败 1、说不准 1。总体：失败

1. [高危] C.2 git 凭据助手指向一个不存在的程序
   → git config --global --unset-all credential.https://github.com.helper（共 2 条命令，见报告）
2. [中危] E.1 已装插件的版本要求与当前 DSH 不匹配
   → dsh plugin --profile desktop add @roarpeng/graphflow@2.2.9
3. [低危] F.1 系统盘剩余空间
   → 没有可直接执行的修复命令，见报告里的「为什么」

说不准：D.1（原因见报告）
全文：C:\Users\神\Documents\deepseek-harness\default-workspace\.dsh-doctor\report-20261014-171203.md

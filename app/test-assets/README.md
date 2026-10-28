# 受控测试资产（test assets）

用途：为「第二次可比较观察 → 确定性 Diff → intel_event → 收件箱 → 前后值 → 证据抽屉」提供
**可重复**的受控来源。仅在 `ZB_TEST_ASSETS=1` 时启用；启用后也只接管保留域名 `*.zb.test`，
其余主机一律走真实网络。

- `cera.zb.test/products.json`：Shopify 公开目录同形 JSON（商品价格是唯一可变字段）。
- `cera.zb.test/cart.js`：与真实 Shopify 同形的币种响应。

纪律：
1. 不进入生产默认数据：默认 `ZB_TEST_ASSETS=0`，镜像内不含被启用的测试品牌。
2. 只替换传输层字节；解析、快照、证据、契约、Diff 全部走真实实现。
3. 禁止用它直接写事件表——事件必须由两次观察的 Diff 产生。

# MetaID Aggregated PINS: Social & Interaction
**说明**：此文档介绍了和社交和互动相关的聚合数据获取方式,可以获取最新 buzz、推荐 buzz、热门 buzz、关注人的 buzz、搜索 buzz、指定 metaid 的关注者和正在关注的人等。

## Show.Now上的和社交相关的 API 服务
### base_url:
`https://show.now/man` 

### 可用接口：
**获取最新 buzz：其中参数followed为过滤是否只查看关注的用户（1 为关注 0 为不关注）**

`GET /social/buzz/newest`
Inputs: `lastId`(query,string), `size`(query,int), `metaid`(query,string,可选), `followed`(query,int,1/0)。
Outputs: `data.list` Buzz 列表，`data.total`，`data.lastId`。
Buzz 列表主要字段说明：
        - "id": pinid
        - "number": 排序号
        - "metaid": 发PIN 者（作者）的 metaid
        - "address": 发PIN 者（作者）的地址
        - "creator": 创建者的地址
        - "timestamp": 发帖的时间戳
        - "operation": 该 PIN 的操作符标识‘create|modify|revoke’，对应 metaid 协议七元组的 operation
        - "path": 该 PIN 的路径，对应 metaid 七元组数据的 path
        - "contentType": 内容格式的 mime， 对应 metaid协议 七元组数据的 contentType
        - "contentSummary": 该帖子的内容摘要只截取 content 的部分长度，大概只显示 content 的前 144 个字符
        - "content": 该帖子的全文，一般来说，展示这个字段的全部内容给用户
        - "chainName": 该 PIN 所在哪个网络/公链，‘mvc|btc|doge’,
        - "likeCount": 该 PIN 有多少个点赞
        - "commentCount": 该 PIN 有多少个评论
        - "hot": 是否热贴，1-是，0-否
        - "donateCount": 打赏次数
        - "forwardCount": 转发次数

**获取根据用户地址的个性化推荐 buzz：**
`GET /social/buzz/recommended`
Inputs: `lastId`(query,string), `size`(query,int), `userAddress`(query,string,可选)。
Outputs: 同上。

**获取最热的 buzz：**
`GET /social/buzz/hot`
Inputs: `lastId`(query,string), `size`(query,int,<=50)。
Outputs: 同 `newest`。

**根据关键词搜索 buzz：**
`GET /social/buzz/search`
Inputs: `lastId`(query,string), `size`(query,int), `key`(query,string)。
Outputs: 同 `newest`。

**根据根据PINID 显示具体buzz详情：**
`GET /social/buzz/info`
Inputs: `pinId`(query,string)。
Outputs: `data.tweet`, `data.comments`, `data.like`, `data.donates`, `data.blocked`。

### 参考例子
获取最新的 10 条 buzz：
`https://www.show.now/man/social/buzz/newest?size=10&lastId=`


## MAN 上的和社交相关的API服务
### base_url:
`https://man.metaid.io` 

### 可选接口：
**获取指定地址的最新通知/互动信息：**
`GET /api/notifcation/list`
Inputs: `userAddress`(query,string), `size`(query,int), `userAddress`(query,string,可选)。
Outputs: 
 - "notifcationType": 通知/互动类型
 - "fromPinId": 通知/互动的 PINID
 - "fromAddress": 发送互动的地址，可用这个地址去获取用户名字和头像等
 - "notifcationTime": 通知/互动的时间戳

**获取指定 metaid 的 关注者**
`GET /api/metaid/followerList/$metaid?cursor=0&size=$size&followDetail=true`
Inputs: `metaid`(query,string), `cursor`(query,int,defaulting:0), `size`(query,int)

**获取指定 metaid 的正在关注的人**
`GET /api/metaid/followingList/$metaid?cursor=0&size=$size&followDetail=true`
Inputs: `metaid`(query,string), `cursor`(query,int,defaulting:0), `size`(query,int)


### 参考例子例子
`https://man.metaid.io/api/metaid/followerList/0d166d6c6e2ac2f839fb63e22bd93ed571fc06940eadca0986427402eb688a4d?cursor=0&size=10&followDetail=true`

`https://man.metaid.io/api/notifcation/list?address=12ghVWG1yAgNjzXj4mr3qK9DgyornMUikZ&lastId=1773555167558&size=100`
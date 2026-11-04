import test from 'node:test';
import assert from 'node:assert/strict';
import { detectMutualFriendInviteIntent } from '../src/main/services/friendGuidanceIntent';

/**
 * S6 final-verification defect #4: the owner's explicit mutual-friend
 * instruction (「请完成互相关注」typed into the A2A private chat with a peer
 * who ALREADY follows the local bot) must deterministically reach the S5
 * owner-authorization card. These vectors pin the detector's precision
 * contract: unmistakable mutual-friendship markers trigger; negations,
 * removals, blocks, and feature-development phrasing never do.
 */

test('detects the exact real-device phrasing and common mutual-friend instructions', () => {
  // The literal instruction from the S6 final verification.
  assert.equal(detectMutualFriendInviteIntent('请完成互相关注'), true);
  // The peer already follows the local bot — the state that used to strand.
  assert.equal(detectMutualFriendInviteIntent('对方已经关注我了，请完成互相关注'), true);
  assert.equal(detectMutualFriendInviteIntent('跟对方互加好友'), true);
  assert.equal(detectMutualFriendInviteIntent('我们互关注一下吧'), true);
  assert.equal(detectMutualFriendInviteIntent('和 TA 相互关注'), true);
  assert.equal(detectMutualFriendInviteIntent('你们互关一下'), true);
  assert.equal(detectMutualFriendInviteIntent('彼此关注一下吧'), true);
  assert.equal(detectMutualFriendInviteIntent('双向关注才算好友'), true);
  assert.equal(detectMutualFriendInviteIntent('把你们加为好友'), true);
  assert.equal(detectMutualFriendInviteIntent('让我们成为链上好友'), true);
  assert.equal(detectMutualFriendInviteIntent('互粉一下'), true);
  assert.equal(detectMutualFriendInviteIntent('Please follow each other'), true);
  assert.equal(detectMutualFriendInviteIntent('you two should mutually follow'), true);
  assert.equal(detectMutualFriendInviteIntent('become friends on-chain'), true);
  assert.equal(detectMutualFriendInviteIntent('add each other as friends'), true);
});

test('negated or removal instructions never trigger (deny dominates)', () => {
  assert.equal(detectMutualFriendInviteIntent('先不要互相关注'), false);
  assert.equal(detectMutualFriendInviteIntent('别互加好友了'), false);
  assert.equal(detectMutualFriendInviteIntent('无需关注对方'), false);
  assert.equal(detectMutualFriendInviteIntent('取消相互关注'), false);
  assert.equal(detectMutualFriendInviteIntent('取消好友关系'), false);
  assert.equal(detectMutualFriendInviteIntent('解除好友'), false);
  assert.equal(detectMutualFriendInviteIntent('把他拉黑'), false);
  assert.equal(detectMutualFriendInviteIntent('Please unfollow each other'), false);
  assert.equal(detectMutualFriendInviteIntent("don't follow him"), false);
});

test('ordinary guidance and feature-development phrasing never trigger', () => {
  assert.equal(detectMutualFriendInviteIntent('你好，请继续讨论刚才的话题'), false);
  assert.equal(detectMutualFriendInviteIntent('帮我实现加好友功能的UI'), false);
  assert.equal(detectMutualFriendInviteIntent('评审一下好友列表的API合同'), false);
  assert.equal(detectMutualFriendInviteIntent('关注一下对方的最新动态'), false);
  assert.equal(detectMutualFriendInviteIntent('follow up on the deploy'), false);
  assert.equal(detectMutualFriendInviteIntent(''), false);
  assert.equal(detectMutualFriendInviteIntent(null as never), false);
  // 互关 shorthand must not fire on 互关系/互关联 phrasings.
  assert.equal(detectMutualFriendInviteIntent('讲讲你们互关系怎么建模的'), false);
  assert.equal(detectMutualFriendInviteIntent('这两个字段互关联的'), false);
});

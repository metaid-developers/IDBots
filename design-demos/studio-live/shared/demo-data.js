(() => {
  const decisionReport = {
    kicker: 'Owner decision brief',
    title: 'Four decisions move the work forward',
    summary: 'The evidence has been gathered and independently checked. Each decision can be answered in one short reply.',
    items: [
      { title: 'Trial cohort', body: 'Provide the first trial candidates. One or two people are enough to start.', action: 'Share names', tone: 'urgent' },
      { title: 'Desktop release', body: 'The new pricing and balance experience is ready to be packaged.', action: 'Reply “Release”', tone: 'ready' },
      { title: 'Backend handoff', body: 'Forward the prepared P0 report to the external backend contact.', action: 'Forward file', tone: 'waiting' },
      { title: 'Market closeout', body: 'Close AC#1 using verified external sales as the evidence.', action: 'Choose A', tone: 'ready' }
    ],
    footer: 'Recommended next step: start with the trial cohort, then approve the desktop release. Other tracked work continues automatically.'
  };

  const bpReport = {
    kicker: 'Projection verified',
    title: 'The November BP is on the big screen',
    summary: 'The independent presentation copy is open in the projection tab. Content, navigation, imagery, and scaling were checked.',
    stats: [
      { value: '13', label: 'presentation pages' },
      { value: '2', label: 'navigation methods' },
      { value: '1', label: 'original file left untouched' }
    ],
    items: [
      { title: 'Ready to present', body: 'Use arrow keys, Space, or the navigation dots to move through the deck.', action: 'Open projection', tone: 'ready' },
      { title: 'Context preserved', body: 'The previous browser tab remains available and the source BP was not modified.', action: 'Continue discussion', tone: 'waiting' }
    ],
    footer: 'Suggested next step: continue with the section you want to discuss. The live process remains available through Back.'
  };

  const greetingReport = {
    kicker: 'Welcome to Studio',
    title: 'Hello, I am AI_Sunny',
    summary: 'Bring a goal, a question, or something that needs follow-up. I will work through it and keep the outcome visible here.',
    items: [
      { title: 'Talk naturally', body: 'Use the existing composer on the left. Your text transcript stays available for reference.', action: 'Write a request', tone: 'ready' },
      { title: 'Watch the work', body: 'The right stage shows research, delegation, verification, and moments that need your decision.', action: 'Start a task', tone: 'waiting' }
    ],
    footer: 'No complex request is needed. A simple “what needs my attention today?” is enough to begin.'
  };

  window.StudioScenarios = {
    decision: {
      label: 'Decision follow-up',
      sessionTitle: '需要你拍板跟进的事项',
      user: '我们从这里开始吧。现在有什么事情是需要我跟进、我处理、我拍板的？将事情继续往前推吧。',
      report: decisionReport,
      steps: [
        {
          id: 'received', family: 'received', verb: 'Received',
          title: 'Understanding what needs you',
          caption: 'Your Twin has the request and is identifying the open loops.',
          participants: ['Owner', 'Twin'],
          message: '我先梳理当前有哪些事项卡在等你跟进或拍板，再逐项说明进展和需要你决定的地方。'
        },
        {
          id: 'gather', family: 'local-recall', verb: 'Gather',
          title: 'Gathering the open loops',
          caption: 'Task board, past conversations, release state, and MetaWeb evidence are being checked at the source.',
          participants: ['Task board', 'Conversations', 'MetaWeb'],
          message: '我还在梳理哪些事项需要你跟进和拍板，整理好就发给你。'
        },
        {
          id: 'delegate', family: 'delegation', verb: 'Delegate',
          title: 'One proof needs a specialist',
          caption: 'The final S9 anchor proof is sent back to its original session for a read-only verification.',
          participants: ['Twin', 'S9 session'],
          message: '清单已经整理好。S9 最后一格验证已派人开跑，回执一到我就做验收。'
        },
        {
          id: 'worker-report', family: 'worker-report', verb: 'Return',
          title: 'The worker has reported back',
          caption: 'Evidence has returned. It is a delivery, not yet an accepted result.',
          participants: ['S9 session', 'Evidence', 'Twin'],
          notice: 'S9 session delivered a verification receipt.'
        },
        {
          id: 'verify', family: 'verification', verb: 'Verify',
          title: 'Checking the claim against proof',
          caption: 'Your Twin reads the original artifacts and independently recalculates the proof before accepting the result.',
          participants: ['Claim', 'Original evidence', 'Twin'],
          message: '回执到了。我先一手核对原始证据，再给你最终验收结论。'
        },
        {
          id: 'ready', family: 'report-ready', verb: 'Ready',
          title: 'Four decisions need you',
          caption: 'The verification is complete. The remaining owner actions are curated into one clear report.',
          participants: ['4 decisions', 'Report'],
          message: '盘点完成：真正需要你的只有 4 件，全部一句话可收；其余都在自动推。清单已投到右侧大屏。',
          reportReady: true
        }
      ]
    },
    bp: {
      label: 'Open the BP',
      sessionTitle: '继续讨论BP并打开大屏幕',
      user: '我们在这里继续聊这个 BP，你先在大屏幕打开这个 BP。',
      report: bpReport,
      steps: [
        {
          id: 'received', family: 'received', verb: 'Received',
          title: 'Opening the right BP',
          caption: 'Your Twin is connecting this request with the version you discussed earlier.',
          participants: ['Owner', 'Twin'],
          message: '好的，我先在大屏幕上把这个 BP 打开，然后我们接着聊。'
        },
        {
          id: 'recall', family: 'local-recall', verb: 'Locate',
          title: 'Finding the finalized version',
          caption: 'The prior conversation and local workspace identify the November edition without altering the source.',
          participants: ['Prior session', 'BP source'],
          message: '我先核对今天下午定稿的版本和原稿位置。'
        },
        {
          id: 'making', family: 'making', verb: 'Prepare',
          title: 'Preparing an independent screen copy',
          caption: 'A presentation copy adds responsive scaling and session markers while the original stays untouched.',
          participants: ['Source', 'Screen copy'],
          message: '版本已确认，我正在为大屏准备一份独立工作副本。'
        },
        {
          id: 'browser', family: 'browser-action', verb: 'Project',
          title: 'Lighting up the big screen',
          caption: 'The new presentation opens in the session projection tab without disturbing your other browser tabs.',
          participants: ['Projection tab', '13 pages'],
          message: '大屏已经亮了，我再检查一下内容渲染和翻页。'
        },
        {
          id: 'verify', family: 'verification', verb: 'Verify',
          title: 'Looking at every critical detail',
          caption: 'Screenshots and click-through checks verify imagery, scaling, and navigation instead of assuming the page works.',
          participants: ['Screenshot', 'Navigation', 'Twin'],
          message: '封面、配图和翻页都已实测，我再回到封面交给你。'
        },
        {
          id: 'ready', family: 'report-ready', verb: 'Ready',
          title: 'The BP is ready to discuss',
          caption: 'Thirteen pages are projected and verified. The previous tab and original source remain available.',
          participants: ['13 pages', 'Verified'],
          message: '「AI 互联网 BP · 11 月版」现在就投在投影页签上，停在封面页，内容渲染、翻页、配图全部核验过。',
          reportReady: true
        }
      ]
    },
    greeting: {
      label: 'Simple greeting',
      sessionTitle: '你好问候',
      user: '你好',
      report: greetingReport,
      steps: [
        {
          id: 'received', family: 'received', verb: 'Hello',
          title: 'Your Twin is here',
          caption: 'No tools are needed. The visual presence responds with the first greeting.',
          participants: ['Owner', 'Twin'],
          message: '你好呀，很高兴见到你！'
        },
        {
          id: 'speaking', family: 'speaking', verb: 'Respond',
          title: 'A direct answer, not a task dashboard',
          caption: 'The stage stays warm and lightweight for a simple conversation.',
          participants: ['Twin'],
          message: '我在。你可以把最近想推进的事直接告诉我。'
        },
        {
          id: 'ready', family: 'report-ready', verb: 'Welcome',
          title: 'A useful first page',
          caption: 'The welcome projection introduces what your Twin can help you move forward.',
          participants: ['Welcome page'],
          message: '右侧已经亮起本次会话的第一页投影。你想先做别的也可以，说一句你手头想推进的事就好。',
          reportReady: true
        }
      ]
    }
  };
})();

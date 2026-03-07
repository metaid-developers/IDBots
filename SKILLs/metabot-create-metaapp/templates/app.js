/**
 * App Configuration, ServiceLocator, & Initialization
 * 
 * This file contains:
 * - ServiceLocator: Service endpoint configuration
 * - Application-specific Models: Custom models for this application
 * - Command Registration: Register application commands
 * - Application Initialization: Startup logic
 */

// ============================================
// ServiceLocator - Service Endpoint Configuration
// ============================================
// Define base URLs for various services used by BusinessDelegate.
// idconfig.js may have already set ServiceLocator defaults; here we override or extend.
// For MetaID user registration, set window.__createOrUpdateUserInfoImpl to your implementation.
window.ServiceLocator = {
  metaid_man: 'https://manapi.metaid.io', // MetaID data indexer API
  metafs: 'https://file.metaid.io/metafile-indexer/api', // MetaFS service for user info and avatars
  idchat: 'https://api.idchat.io/chat-api/group-chat', // IDChat API service
  // Add more services as needed:
  // metaid_node: 'https://node.metaid.io',
  // custom_service: 'https://api.example.com',
};

// ============================================
// Application-Specific Models
// ============================================
// These models extend the framework's built-in models (wallet, app)
// All models are managed through Alpine.js stores for reactive updates


// UserModel - Application-specific model for user data
// Stores user information keyed by metaid
const UserModel = {
  users: {}, // { metaid: { globalMetaId, metaid, name, address, avatar, avatarId, chatpubkey, chatpubkeyId, avatarImg } }
  isLoading: false,
  error: null,
};

// ============================================
// Framework Initialization
// ============================================
// Initialize IDFramework with built-in models and custom application models
// Note: Stores may already be registered in index.html's alpine:init
// This ensures framework initialization happens even if framework loads after alpine:init
window.addEventListener('alpine:init', () => {
  // Wait for framework to be available (if not already)
  const initFramework = () => {
    if (window.IDFramework) {
      // Initialize framework with built-in models (wallet, app)
      // and register custom application models
      // If stores already exist, initModels will update them
      IDFramework.init({
        // Register application-specific models
        user: UserModel,
        // Add more custom models as needed:
        // settings: SettingsModel,
      });
    } else {
      // Framework not loaded yet, wait a bit and try again
      setTimeout(initFramework, 10);
    }
  };
  
  initFramework();
});

// ============================================
// Application Initialization
// ============================================
// Register application commands and perform startup tasks
window.addEventListener('DOMContentLoaded', async () => {
  // Wait for Alpine to be fully loaded
  const waitForAlpine = () => {
    return new Promise((resolve) => {
      // If Alpine is already loaded
      if (typeof Alpine !== 'undefined') {
        resolve();
        return;
      }
      
      // Wait for Alpine to load (with defer, it loads after DOM)
      const checkInterval = setInterval(() => {
        if (typeof Alpine !== 'undefined') {
          clearInterval(checkInterval);
          resolve();
        }
      }, 50);
      
      // Timeout after 5 seconds
      setTimeout(() => {
        clearInterval(checkInterval);
        console.error('Alpine.js failed to load within 5 seconds');
        resolve();
      }, 5000);
    });
  };

  await waitForAlpine();

  // Verify framework is initialized
  if (!window.IDFramework) {
    console.error('IDFramework is not loaded. Please include idframework.js before app.js');
    return;
  }

  // Ensure framework is initialized (registers built-in commands)
  // This is safe to call multiple times - initModels won't overwrite existing stores
  // and registerBuiltIn will just update the command if it already exists
  IDFramework.init({
    user: UserModel,
  });

  // ============================================
  // Route Configuration (DISABLED)
  // ============================================
  // Routing functionality is temporarily disabled
  // Uncomment below to enable routing:
  /*
  const routes = [
    { path: '/', view: 'home' },
    { path: '/home', view: 'home' },
    { path: '/profile/:id', view: 'profile' },
  ];
  IDFramework.IDRouter.init(routes);
  */

  // ============================================
  // Register Application Commands
  // ============================================
  // Register file-based commands for this application

  // IDFramework.IDController.register('ROUTE_CHANGE', './commands/NavigateCommand.js'); // Disabled - routing disabled
  IDFramework.IDController.register('fetchUser', './commands/FetchUserCommand.js');
  IDFramework.IDController.register('fetchUserInfo', './commands/FetchUserInfoCommand.js');
  IDFramework.IDController.register('fetchBuzz', './commands/FetchBuzzCommand.js');
  IDFramework.IDController.register('postBuzz', './commands/PostBuzzCommand.js');
  IDFramework.IDController.register('sendChatMessage', './commands/SendChatMessageCommand.js');
  IDFramework.IDController.register('getPinDetail', './commands/GetPinDetailCommand.js');
  IDFramework.IDController.register('checkWebViewBridge', './commands/CheckWebViewBridgeCommand.js');
  IDFramework.IDController.register('checkBtcAddressSameAsMvc', './commands/CheckBtcAddressSameAsMvcCommand.js');
  
  // Built-in commands are already registered by IDFramework.init()
  // You can also register additional built-in commands here if needed:
  // IDFramework.IDController.registerBuiltIn('customCommand', customFunction);

  // ============================================
  // Application Startup Tasks
  // ============================================
  // Perform any initialization tasks, such as:
  // - Loading components dynamically (lazy loading)
  // - Auto-fetching initial data
  // - Checking wallet connection status
  // - Restoring user session
  
});


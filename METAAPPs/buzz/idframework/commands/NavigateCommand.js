/**
 * NavigateCommand - Business Logic for handling route changes
 * 
 * Command Pattern implementation following IDFramework architecture.
 * 
 * This command:
 * 1. Receives route change event (view and params)
 * 2. Dynamically loads the required Web Component using lazy loading
 * 3. Updates the Model (app store) with current route state
 * 
 * @class NavigateCommand
 */
export default class NavigateCommand {
  /**
   * Execute the command
   * 
   * Command execution flow:
   * 1. Extract view and params from payload
   * 2. Dynamically load the corresponding Web Component
   * 3. Update app store with current route state
   * 
   * @param {Object} params - Command parameters
   * @param {Object} params.payload - Event payload
   *   - view: {string} - View name (e.g., 'home', 'profile')
   *   - params: {Object} - Route parameters (e.g., { id: '123' })
   *   - path: {string} - Full route path (e.g., '/profile/123')
   * @param {Object} params.stores - Alpine stores object
   *   - app: {Object} - App store (currentView, routeParams, etc.)
   * @param {Function} params.delegate - BusinessDelegate function (not used in this command)
   * @returns {Promise<void>}
   */
  async execute({ payload = {}, stores, delegate }) {
    try {
      const { view, params = {}, path } = payload;
      
      if (!view) {
        console.warn('NavigateCommand: No view specified in payload');
        return;
      }

      const appStore = stores.app;
      if (!appStore) {
        console.error('NavigateCommand: App store not found');
        return;
      }

      // Step 1: Map view name to component file path
      // Convention: view 'home' -> component 'id-home-view.js'
      //            view 'profile' -> component 'id-profile-view.js'
      const componentName = `id-${view}-view`;
      const configuredBasePath =
        appStore.routeComponentBasePath ||
        (window.IDFrameworkConfig && window.IDFrameworkConfig.routeComponentBasePath) ||
        window.IDFrameworkRouteComponentBasePath ||
        '@idf/components/';
      const normalizedBasePath = configuredBasePath.endsWith('/')
        ? configuredBasePath
        : `${configuredBasePath}/`;
      const componentPath = `${normalizedBasePath}${componentName}.js`;

      // Step 2: Dynamically load the component
      try {
        await IDFramework.loadComponent(componentPath);
        console.log(`NavigateCommand: Component loaded: ${componentName}`);
      } catch (error) {
        console.error(`NavigateCommand: Failed to load component ${componentName}:`, error);
        // Continue anyway - component might already be loaded or will be loaded later
      }

      // Step 3: Update Model with current route state
      appStore.currentView = view;
      appStore.routeParams = params;
      appStore.currentPath = path || window.location.hash.replace(/^#/, '') || '/';

      console.log(`NavigateCommand: Navigated to view '${view}' with params:`, params);
    } catch (error) {
      console.error('NavigateCommand error:', error);
      throw error;
    }
  }
}

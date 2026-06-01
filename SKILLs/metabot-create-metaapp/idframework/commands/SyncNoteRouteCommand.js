import { parseNoteRoute } from '../utils/note-route.js';

export default class SyncNoteRouteCommand {
  async execute({ payload = {}, stores }) {
    const hasWindow = typeof window !== 'undefined';
    const locationLike = payload.locationLike || (hasWindow ? window.location : {});
    const route = parseNoteRoute(locationLike, hasWindow ? window : {});
    stores.app.route = route;
    stores.note.route = route;
    return route;
  }
}

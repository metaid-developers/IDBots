import { buildUseMetaAppPrompt } from './metaAppPresentation.js';

export async function startMetaAppSession({ app, coworkService }) {
  const prompt = buildUseMetaAppPrompt(app);
  return coworkService.startSession({ prompt });
}

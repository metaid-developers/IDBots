import { configureStore } from '@reduxjs/toolkit';
import modelReducer from './slices/modelSlice';
import coworkReducer from './slices/coworkSlice';
import browserCoworkReducer from './slices/browserCoworkSlice';
import skillReducer from './slices/skillSlice';
import imReducer from './slices/imSlice';
import quickActionReducer from './slices/quickActionSlice';
import scheduledTaskReducer from './slices/scheduledTaskSlice';
import longTermTaskReducer from './slices/longTermTaskSlice';
import metataskReducer from './slices/metataskSlice';
import groupTasksReducer from './slices/groupTasksSlice';
import mcpReducer from './slices/mcpSlice';
import agentGameReducer from './slices/agentGameSlice';

export const store = configureStore({
  reducer: {
    model: modelReducer,
    cowork: coworkReducer,
    browserCowork: browserCoworkReducer,
    skill: skillReducer,
    im: imReducer,
    quickAction: quickActionReducer,
    scheduledTask: scheduledTaskReducer,
    longTermTask: longTermTaskReducer,
    metatask: metataskReducer,
    groupTasks: groupTasksReducer,
    mcp: mcpReducer,
    agentGame: agentGameReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: false,
      immutableCheck: false,
    }),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch; 

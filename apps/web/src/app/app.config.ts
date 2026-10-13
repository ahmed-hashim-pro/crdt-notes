import { ApplicationConfig, provideAppInitializer, provideBrowserGlobalErrorListeners, inject } from '@angular/core';
import { NotesStore } from './store';
import { SyncService } from './sync';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideAppInitializer(async () => {
      const store = inject(NotesStore);
      const sync = inject(SyncService);
      await store.init();
      sync.start();
    }),
  ],
};

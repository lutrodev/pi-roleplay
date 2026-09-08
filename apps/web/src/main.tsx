import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { createRootRoute, createRoute, createRouter, RouterProvider, lazyRouteComponent } from '@tanstack/react-router'
import { MotionConfig } from 'motion/react'
import { App, HomePage } from './app.tsx'
import { queryClient } from './lib/api.ts'
import { MissingPage, PageLoadError } from './components/app-states.tsx'
import './styles.css'

const root = createRootRoute({ component: App, errorComponent: PageLoadError, notFoundComponent: MissingPage })
const index = createRoute({ getParentRoute: () => root, path: '/', component: HomePage })
const story = createRoute({ getParentRoute: () => root, path: '/stories/$storyId', component: lazyRouteComponent(() => import('./pages/story/index.tsx'), 'StoryPage') })
const newConversation = createRoute({ getParentRoute: () => root, path: '/new', validateSearch: (search: Record<string, unknown>) => ({ workspace: typeof search.workspace === 'string' ? search.workspace : undefined }), component: lazyRouteComponent(() => import('./pages/new-conversation.tsx'), 'NewConversationPage') })
const library = createRoute({ getParentRoute: () => root, path: '/library', component: lazyRouteComponent(() => import('./pages/library.tsx'), 'LibraryPage') })
const settings = createRoute({ getParentRoute: () => root, path: '/settings', component: lazyRouteComponent(() => import('./pages/settings.tsx'), 'SettingsPage') })
const router = createRouter({ routeTree: root.addChildren([index, story, newConversation, library, settings]), defaultPreload: 'intent' })
declare module '@tanstack/react-router' { interface Register { router: typeof router } }

// Entry and recovery screens also respect the system theme before settings load.
document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'

createRoot(document.getElementById('root')!).render(<StrictMode><QueryClientProvider client={queryClient}><MotionConfig reducedMotion="user"><RouterProvider router={router} /></MotionConfig></QueryClientProvider></StrictMode>)

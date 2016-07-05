import { action } from 'mobx'
import App from '../lib/app'
import projectsStore from '../projects/projects-store'
import Promise from 'bluebird'

const getProjects = () => {
  projectsStore.loading(true)
  App.ipc('get:project:paths')
  .then(action('got:projects:paths', (paths) => {
    projectsStore.setProjects(paths)
  }))
}

const addProject = () => {
  let project
  return App.ipc('show:directory:dialog')
  .then(action('directory:dialog:closed', (path) => {
     // if the user cancelled the dialog selection
     // path will be undefined
    if (!path) return

    // initially set our project to be loading state
    project = projectsStore.addProject(path)
    project.loading(true)

    return Promise.all([
      App.ipc('add:project', path),
    ])
    .then(() => {
      return project.loading(false)
    })
  }))
  .catch((err) => {
    projectsStore.setError(err.message)
  })
}

const launchBrowser = (project, browser, url) => {
  project.setChosenBrowserByName(browser)
  // project.browserOpening()

  App.ipc('launch:browser', { browser, url }, (err, data = {}) => {
    if (data.browserOpened) {
      // project.browserOpened()
    }

    if (data.browserClosed) {
      App.ipc.off('launch:browser')
      // project.browserClosed()
    }
  })
}

const closeProject = () => {
  return App.ipc("close:project")
}

const openProject = (project) => {
  project.loading(true)
  return App.ipc('open:project', project.path)
  .then(action('project:opened', (config) => {
    project.setOnBoardingConfig(config)
    project.setBrowsers(config.browsers)
    project.setResolvedConfig(config.resolved)
  }))
  .then(() => {
    project.loading(false)
    // create a promise which listens for
    // project settings change events
    // and updates our project model
    const listenToProjectSettingsChange = () => {
      return App.ipc('on:project:settings:change')
      .then(action('project:config:changed', (data = {}) => {
        project.reset()
        project.setBrowsers(data.config.browsers)

        // if we had an open browser then launch it again!
        if (data.browser) {
          launchBrowser(project, data.browser)
        }

        // recursively listen for more
        // change events!
        return listenToProjectSettingsChange()
      }))
    }
    return listenToProjectSettingsChange()
  })
  .catch(action('project:open:errored', (err) => {
    project.loading(false)
    project.setError(err)
  }))
}

export {
  getProjects,
  openProject,
  closeProject,
  addProject,
}

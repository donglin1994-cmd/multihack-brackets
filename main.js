/* jslint vars: true, plusplus: true, devel: true, nomen: true, regexp: true, indent: 4, maxerr: 50 */
/* global define, $, brackets, window, Mustache */

define(function (require, exports, module) {
  
  var START_COMMAND_ID = 'rationalcoding.multihack.start'
  var STOP_COMMAND_ID = 'rationalcoding.multihack.stop'
  var VOICE_JOIN_COMMAND_ID = 'rationalcoding.multihack.voicejoin'
  var VOICE_LEAVE_COMMAND_ID = 'rationalcoding.multihack.voiceleave'
  var FORCE_SYNC_COMMAND_ID = 'rationalcoding.multihack.forcesync'
  
  var DEFAULT_HOSTNAME = 'https://quiet-shelf-57463.herokuapp.com'
  var MAX_PUBLIC_SIZE = 20000000 // 20 mb max for public server
  
  var AppInit = brackets.getModule('utils/AppInit')
  var CommandManager = brackets.getModule('command/CommandManager')
  var Menus = brackets.getModule('command/Menus')
  var PreferencesManager = brackets.getModule('preferences/PreferencesManager')
  var EditorManager = brackets.getModule('editor/EditorManager')
  var DocumentManager = brackets.getModule('document/DocumentManager')
  var ProjectManager = brackets.getModule('project/ProjectManager')
  var FileSystem = brackets.getModule('filesystem/FileSystem')
  var FileUtils = brackets.getModule('file/FileUtils')
  var Dialogs = brackets.getModule("widgets/Dialogs")
        
  var fileMenu = Menus.getMenu(Menus.AppMenuBar.FILE_MENU)
  var prefs = PreferencesManager.getExtensionPrefs('multihack-brackets')

  var RemoteManager = require('lib/remote')

  var remote = null
  var isSyncing = false
  var isInCall = false
  var currentEditor = null
  var editorMutexLock = false
  var projectBasePath = null
  var documentRelativePath = null
  var changeQueue = {}

  CommandManager.register('Start MultiHack', START_COMMAND_ID, handleStart)
  CommandManager.register('Stop MultiHack', STOP_COMMAND_ID, handleStop)
  CommandManager.register('Join Voice Call', VOICE_JOIN_COMMAND_ID, handleVoiceJoin)
  CommandManager.register('Leave Voice Call', VOICE_LEAVE_COMMAND_ID, handleVoiceLeave)
  CommandManager.register('Force Sync', FORCE_SYNC_COMMAND_ID, handleForceSync)

  function init () {
    setupPreferences()
    addMenuItem()
    setupEventListeners()
  }

  function setupPreferences () {
    prefs.definePreference('hostname', 'string', DEFAULT_HOSTNAME)
    prefs.save()
  }

  function addMenuItem () {
    fileMenu.addMenuItem(START_COMMAND_ID)
  }

  function setupEventListeners () {
    projectBasePath = ProjectManager.getProjectRoot().fullPath
    ProjectManager.on('projectOpen', handleStop) // Stop sync on project open
    EditorManager.on('activeEditorChange', handleEditorChange)
    DocumentManager.on('pathDeleted', handleLocalDeleteFile)
  }
  
  function handleVoiceJoin () {
    fileMenu.removeMenuItem(VOICE_JOIN_COMMAND_ID)
    fileMenu.addMenuItem(VOICE_LEAVE_COMMAND_ID)
    
    remote.voice.join()
    isInCall = true
  }
  
  function handleVoiceLeave () {
    fileMenu.removeMenuItem(VOICE_LEAVE_COMMAND_ID)
    fileMenu.addMenuItem(VOICE_JOIN_COMMAND_ID)
    
    remote.voice.leave()
    isInCall = false
  }
  
  function handleForceSync () {
    remote.requestProject()
  }

  function handleStart () {
    Dialogs.showModalDialog(
      '', 
      'Multihack', 
      '<p>Enter the ID for the room you want to join.</p><input id="multihack-room" placeholder="roomID" type="text"></input><p>Make sure all members have the same project before starting.</p>', 
      [customButton('Join Room', true), customButton('Cancel')]
    )
    var roomInput = document.querySelector('#multihack-room')
    roomInput.value = Math.random().toString(36).substr(2, 20)
    roomInput.select()
    
    document.querySelector('[data-button-id="multihack-button-JoinRoom"]').addEventListener('click', function () {  
      var room = roomInput.value
      if (!room) return
      
      projectBasePath = ProjectManager.getProjectRoot().fullPath
      remote = new RemoteManager(prefs.get('hostname'), room)

      remote.on('change', handleRemoteChange)
      remote.on('deleteFile', handleRemoteDeleteFile)
      remote.on('provideFile', handleRemoteProvideFile)
      remote.on('requestProject', handleRemoteRequestProject)

      fileMenu.removeMenuItem(START_COMMAND_ID)
      fileMenu.addMenuItem(STOP_COMMAND_ID)
      fileMenu.addMenuItem(VOICE_JOIN_COMMAND_ID)
      fileMenu.addMenuItem(FORCE_SYNC_COMMAND_ID)
      isSyncing = true

      console.log('MH started')
    })
  }

  function handleStop () {
    if (remote) {
      remote.destroy()
      remote = null
    }
    
    fileMenu.removeMenuItem(STOP_COMMAND_ID)
    if (isInCall) {
      fileMenu.removeMenuItem(VOICE_LEAVE_COMMAND_ID)
    } else {
      fileMenu.removeMenuItem(VOICE_JOIN_COMMAND_ID)
    }
    fileMenu.removeMenuItem(FORCE_SYNC_COMMAND_ID)
    fileMenu.addMenuItem(START_COMMAND_ID)

    isSyncing = false
    
    console.log('MH stopped')
  }

  function handleEditorChange ($event, newEditor, oldEditor) {
    if (oldEditor) {
      oldEditor._codeMirror.off('change', sendLocalChange)
    }

    if (newEditor) {
      currentEditor = newEditor
      documentRelativePath = FileUtils.getRelativeFilename(projectBasePath, newEditor.document.file.fullPath)
      newEditor._codeMirror.on('change', sendLocalChange)
    }
  }
  
  function sendLocalChange (cm, change) {
    if (editorMutexLock || !isSyncing) return
    if (!documentRelativePath) {
      documentRelativePath = FileUtils.getRelativeFilename(projectBasePath, EditorManager.getActiveEditor().document.file.fullPath)
      if (!documentRelativePath) {
        // Outside of project
        return
      }
    }
    remote.change(documentRelativePath, change) // Send change to remote peers
  }
  
  function handleLocalDeleteFile (e, fullPath) {
    var relativePath = FileUtils.getRelativeFilename(projectBasePath, fullPath)
    if (relativePath.slice(-1) === '/') { // Brackets adds a extra '/' to directory paths
      relativePath = relativePath.slice(0,-1)
    }
    remote.deleteFile(relativePath)
  }
  
  function pushChangeToDocument (absPath, data) {
    return DocumentManager.getDocumentForPath(absPath).then(function (doc) {
      doc.replaceRange(data.change.text, data.change.from, data.change.to)
      doc.on('deleted', function () {
        doc.releaseRef()
      })
      doc.addRef()
    })
  }
  
  function buildPath (absPath, cb) {
    // Build the path
    // HACK: Brackets doesn't offer any sort of path-builder. This is less than ideal
    var split = absPath.split('/')
    for (var i=1; i < split.length; i++) {
      var curPath = split.slice(0, -(split.length-i)).join('/')
      var name = split[i]
      if (!ProjectManager.isWithinProject(curPath+'/'+name)) continue

      var isDir = (i === split.length-1 ? false : true)
      ;(function (curPath, name, isDir) {
        FileSystem.resolve(curPath+'/'+name, function (err) {
          if (err) {
            // HACK: Workaround for adobe/brackets#13267
            if (isDir) name = name + '/'

            ProjectManager.createNewItem(curPath, name, true).then(function () {
              document.body.click() // HACK: Can't skip renaming
              if (!isDir) {
                cb() // we are done when we reach the file at the end of the path
              }
            })
          } 
        })
      }(curPath, name, isDir))
    }
  }
  
  function handleRemoteChange (data) {
    if (data.filePath === documentRelativePath) {
      editorMutexLock = true
      currentEditor._codeMirror.replaceRange(data.change.text, data.change.from, data.change.to)
      editorMutexLock = false
    } else {
      // TODO: Batch changes
      var absPath = projectBasePath+data.filePath
      if (changeQueue[absPath]) {
        changeQueue[absPath].push(data)
        return
      }

      // Push change to document (create if missing)
      pushChangeToDocument(absPath, data).fail(function (err) {
        changeQueue[absPath] = [data]
        
        buildPath(absPath, function () {
          // Empty the queue that built up
          while (changeQueue[absPath][0]) {
            pushChangeToDocument(absPath, changeQueue[absPath].shift())
          }
          delete changeQueue[absPath]
        })
      })
    }
  }
  
  function handleRemoteDeleteFile (data) {
    var absPath = projectBasePath+data.filePath
    FileSystem.resolve(absPath, function (entry) {
      if (entry && entry.moveToTrash) {
        entry.moveToTrash()
        ProjectManager.refreshFileTree()
      }
    })
  }
  
  function handleRemoteProvideFile (data) {
    var absPath = projectBasePath+data.filePath
    buildPath(absPath, function () {
      // file should now exist
      console.log(data.num+' of '+data.total)
    })
  }
  
  function handleRemoteRequestProject (data) {
    ProjectManager.getAllFiles().then(function (allFiles) {
      allFiles.sort(function (a, b) {
        return a.fullPath.length - b.fullPath.length
      })
      
      var isPublicServer = prefs.get('hostname') === DEFAULT_HOSTNAME
      var overSized = false
      var size = 0
      if (isPublicServer && allFiles.length > MAX_PUBLIC_NUMBER)  {
        return alert('More than 1000 files. Please use a private server.')
      }
      for (var i=0; i<allFiles.length; i++) {
        if (overSized) break
        ;(function (i) {
          allFiles[i].read(function (err, contents, stat) {
            if (err || overSized) return
            size=size+stat.size  
            if (isPublicServer && size > MAX_PUBLIC_SIZE) {
              overSized = true
              return alert('Project over 20mb. Please use a private server.')
            }
            var filePath = FileUtils.getRelativeFilename(projectBasePath, allFiles[i].fullPath)
            remote.provideFile(filePath, contents, data.requester, i, allFiles.length)
            console.log('sent '+i+' of '+allFiles.length)
          })
        }(i))
      }
    })
  }
  
  function customButton(text, isPrimary) {
    return {
      id: 'multihack-button-'+text.replace(/\s/g, ''),
      text: text,
      className: isPrimary ? 'primary' : ''
    }
  }

  AppInit.appReady(init)
})

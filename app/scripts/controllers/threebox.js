const ObservableStore = require('obs-store')
const Box = require('3box/dist/3box.min')
const log = require('loglevel')

const JsonRpcEngine = require('json-rpc-engine')
const providerFromEngine = require('eth-json-rpc-middleware/providerFromEngine')
const createMetamaskMiddleware = require('./network/createMetamaskMiddleware')
const createOriginMiddleware = require('../lib/createOriginMiddleware')

class ThreeBoxController {
  constructor (opts = {}) {
    const {
      preferencesController,
      keyringController,
      addressBookController,
      version,
      getKeyringControllerState,
      getSelectedAddress,
      signPersonalMessage,
    } = opts

    this.preferencesController = preferencesController
    this.addressBookController = addressBookController
    this.keyringController = keyringController
    this.provider = this._createProvider({
      static: {
        eth_syncing: false,
        web3_clientVersion: `MetaMask/v${version}`,
      },
      version,
      getAccounts: async ({ origin }) => {
        if (origin !== '3Box') { return [] }
        const isUnlocked = getKeyringControllerState().isUnlocked

        const selectedAddress = getSelectedAddress()

        if (isUnlocked && selectedAddress) {
          return [selectedAddress]
        } else {
          return []
        }
      },
      processPersonalMessage: (msgParams) => {
        return Promise.resolve(signPersonalMessage(msgParams))
      },
    })

    const initState = {
      threeBoxSyncingAllowed: true,
      restoredFromThreeBox: null,
      ...opts.initState,
      threeBoxAddress: null,
      threeBoxSynced: false,
    }
    this.store = new ObservableStore(initState)
    this.registeringUpdates = false

    this.init()
  }

  async init () {
    const accounts = await this.keyringController.getAccounts()
    this.address = accounts[0]
    if (this.address && !(this.box && this.store.getState().threeBoxSynced)) {
      await this.new3Box(this.address)
    }
  }

  async _update3Box ({ type }, newState) {
    const { threeBoxSyncingAllowed, threeBoxSynced } = this.store.getState()
    if (threeBoxSyncingAllowed && threeBoxSynced) {
      await this.space.private.set('lastUpdated', Date.now())
      await this.space.private.set(type, JSON.stringify(newState))
    }
  }

  _createProvider (providerOpts) {
    const metamaskMiddleware = createMetamaskMiddleware(providerOpts)
    const engine = new JsonRpcEngine()
    engine.push(createOriginMiddleware({ origin: '3Box' }))
    engine.push(metamaskMiddleware)
    const provider = providerFromEngine(engine)
    return provider
  }

  _waitForOnSyncDone () {
    return new Promise((resolve) => {
      this.box.onSyncDone(() => {
        log.debug('3Box box sync done')
        return resolve()
      })
    })
  }

  async new3Box (address) {
    if (this.getThreeBoxSyncingState()) {
      this.store.updateState({ threeBoxSynced: false })
      this.address = address

      try {
        this.box = await Box.openBox(address, this.provider)
        await this._waitForOnSyncDone()
        this.space = await this.box.openSpace('metamask', {
          onSyncDone: async () => {
            this.store.updateState({
              threeBoxSynced: true,
              threeBoxAddress: address,
            })
            log.debug('3Box space sync done')
          },
        })
      } catch (e) {
        console.error(e)
        throw e
      }
    }
  }

  async getLastUpdated () {
    return await this.space.private.get('lastUpdated')
  }

  setRestoredFromThreeBox (restored) {
    this.store.updateState({ restoredFromThreeBox: restored })
  }

  async restoreFromThreeBox () {
    this.setRestoredFromThreeBox(true)
    const backedUpPreferences = await this.space.private.get('preferences')
    backedUpPreferences && this.preferencesController.store.updateState(JSON.parse(backedUpPreferences))
    const backedUpAddressBook = await this.space.private.get('addressBook')
    backedUpAddressBook && this.addressBookController.update(JSON.parse(backedUpAddressBook), true)
  }

  turnThreeBoxSyncingOn () {
    this._registerUpdates()
  }

  turnThreeBoxSyncingOff () {
    this.box.logout()
  }

  setThreeBoxSyncingPermission (newThreeboxSyncingState) {
    const currentState = this.store.getState()
    this.store.updateState({
      ...currentState,
      threeBoxSyncingAllowed: newThreeboxSyncingState,
    })

    if (newThreeboxSyncingState && this.box) {
      this.turnThreeBoxSyncingOn()
    }

    if (!newThreeboxSyncingState && this.box) {
      this.turnThreeBoxSyncingOff()
    }
  }

  getThreeBoxSyncingState () {
    return this.store.getState().threeBoxSyncingAllowed
  }

  getThreeBoxAddress () {
    return this.store.getState().threeBoxAddress
  }

  _registerUpdates () {
    if (!this.registeringUpdates) {
      const updatePreferences = this._update3Box.bind(this, { type: 'preferences' })
      this.preferencesController.store.subscribe(updatePreferences)
      const updateAddressBook = this._update3Box.bind(this, { type: 'addressBook' })
      this.addressBookController.subscribe(updateAddressBook)
      this.registeringUpdates = true
    }
  }
}

module.exports = ThreeBoxController

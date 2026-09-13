// Every user-facing string in the app lives here, as a named constant (or, where the
// text needs to interpolate a value, a small function returning one) — never inline in
// JSX or DOM-building code. See docs/DECISIONS.md D22: this is deliberately just data,
// with no logic of its own, so all of it can be rewritten in one pass without touching
// any component or rendering code at all.
//
// Organized by the file each string is used from, in the same nesting shape as the
// component tree (ui/RoomTable.tsx's copy lives under `roomTable`, and so on) — not
// grouped by "kind of string" (all headings together, all buttons together) — since
// that's what makes finding "the text this one component shows" fast, which matters
// more here than being able to browse all the app's button labels as one list.

export const UI_TEXT = {
  login: {
    loginFailedFallback: "login failed",
    title: "rpg-tabletop",
    subtitle: "Admin login. No public signup — accounts are invite-only.",
    usernameLabel: "Username",
    passwordLabel: "Password",
    submitBusy: "Logging in…",
    submit: "Log in",
    firstRunHint: "First run? Log in with admin / admin — you'll be asked to change it.",
    noAccountPrompt: "Just want to play? ",
    noAccountLink: "Start a game without an account",
  },

  accountSetup: {
    passwordMismatch: "passwords don't match",
    setupFailedFallback: "failed to complete setup",
    title: "Finish setting up your account",
    placeholderNotice: (username: string) =>
      `"${username}" is a placeholder, not a real account yet — pick a real username and password to continue.`,
    newUsernameLabel: "New username",
    currentPasswordLabel: "Current password",
    newPasswordLabel: "New password",
    confirmPasswordLabel: "Confirm new password",
    submitBusy: "Saving…",
    submit: "Finish setup",
  },

  roomJoin: {
    loading: "Loading…",
    subtitle: (hasPassword: boolean) => `No account needed — just a display name${hasPassword ? " and this room's password" : ""}.`,
    displayNameLabel: "Display name",
    roomPasswordLabel: "Room password",
    submitBusy: "Joining…",
    submit: "Join",
  },

  newAnonymousRoom: {
    title: "Start a game",
    subtitle: "No account needed — this room isn't saved anywhere on the server.",
    roomNameLabel: "Room name",
    passwordLabel: "Password (optional)",
    gameLabel: "Game",
    genericFreeformOption: "Generic Freeform",
    dnd5eOption: "D&D 5e (SRD)",
    localPackageOption: (name: string) => `${name} (this browser)`,
    submitBusy: "Creating…",
    submit: "Create room",
    haveAccountPrompt: "Have an account? ",
    haveAccountLink: "Log in instead",
  },

  adminDashboard: {
    deleteRoomConfirm: (name: string) => `Delete room "${name}"? This cannot be undone.`,
    title: "rpg-tabletop",
    gamePackagesNavLink: "Game packages",
    loggedInAsPrefix: "Logged in as ",
    logOut: "Log out",
    yourRoomsHeading: "Your rooms",
    guestLinkLabel: "guest link",
    delete: "Delete",
    noRoomsHint: "No rooms yet — create one below.",
    roomNamePlaceholder: "Room name",
    passwordOptionalPlaceholder: "Password (optional)",
    genericFreeformOption: "Generic Freeform",
    dnd5eOption: "D&D 5e (SRD)",
    yourPackageOption: (name: string) => `${name} (yours)`,
    createRoom: "Create room",
    usersHeading: "Users",
    adminSuffix: "(admin)",
    usernamePlaceholder: "Username",
    tempPasswordPlaceholder: "Temp password",
    adminCheckboxLabel: "admin",
    createUser: "Create user",
  },

  gamePackages: {
    deletePackageConfirm: "Delete this package? This cannot be undone.",
    notAPackageFile: "that doesn't look like a game package file",
    importFailedFallback: "failed to import package",
    title: "Game packages",
    dashboardNavLink: "← Dashboard",
    editingHeading: (name: string) => `Edit "${name}"`,
    newPackageHeading: "New game package",
    subtitle:
      "Rules content — tracks, dice, cards, pieces, macros — for rooms to use. Cards can have images or " +
      "just text; pieces can have images or an emoji/symbol. Lives in this browser only (see " +
      "docs/DECISIONS.md D14) — export a package to share or back it up.",
    setCounts: (cardSets: number, pieceSets: number) => `${cardSets} card set(s), ${pieceSets} piece set(s)`,
    edit: "Edit",
    export: "Export",
    delete: "Delete",
    noPackagesHint: "No custom packages yet — create one, or import a file.",
    newPackageButton: "+ New package",
    newPackageDefaultName: "New Package",
  },

  chat: {
    noMessagesHint: "No messages yet. Say hello, or try /roll 1d20.",
    quickSheetSummary: (packageName: string) => `Your sheet (${packageName})`,
    inputPlaceholder: "/roll 1d20 + dex, or just chat",
    send: "Send",
  },

  gamePackageEditor: {
    packageNameLabel: "Package name",
    cancel: "Cancel",
    savePackage: "Save package",
    readImageFailedFallback: "failed to read image",

    tabs: {
      tracks: "Tracks",
      dice: "Dice",
      cards: "Cards",
      pieces: "Pieces",
      mats: "Mats",
      macros: "Macros",
      layout: "Layout",
    },

    layoutTab: {
      sectionTitle: "Layout — where everything starts on the table",
      hint: "Drag a token below to set where that set appears when the room starts.",
      emptyHint: "Add some card sets, piece sets, or mat sets first — then position them here.",
      cardsLegend: "Card sets",
      piecesLegend: "Piece sets",
      matsLegend: "Mat sets",
    },

    tracks: {
      sectionTitle: "Tracks (character-sheet stats)",
      keyPlaceholder: "key",
      labelPlaceholder: "label",
      valuesPlaceholder: "values, e.g. 8,9,10,...,20",
      noPoolDieOption: "no pool die",
      poolDieOption: (dieKey: string) => `pool: ${dieKey}`,
      remove: "Remove",
      addTrack: "+ Add track",
      newTrackDefaultLabel: "New Track",
    },

    dice: {
      sectionTitle: "Dice",
      keyPlaceholder: "key",
      sidesPlaceholder: "sides, e.g. 20",
      facesPlaceholder: "or custom faces, e.g. 0,0,0,1,1,2",
      remove: "Remove",
      addDie: "+ Add die",
    },

    cardSets: {
      sectionTitle: "Card sets — each spawns as one labeled, shufflable stack",
      keyPlaceholder: "set key",
      labelPlaceholder: "label shown on the table, e.g. Role Cards",
      removeSet: "Remove set",
      addSet: "+ Add card set",
    },

    cardEntries: {
      imageAltText: "",
      emptyPreviewPlaceholder: "text",
      titlePlaceholder: "title (or blank for image-only)",
      bodyTextPlaceholder: "body text (optional)",
      readingHint: "reading…",
      clearImage: "Clear img",
      remove: "Remove",
      addCard: "+ Add card",
      newCardDefaultTitle: "New Card",
      // The "+ Add card" button opens this modal to fill in the new card's details,
      // rather than dropping a blank tile straight into the grid — see the explicit
      // request in docs/DECISIONS.md D23.
      modalTitle: "New card",
      modalTitleLabel: "Title",
      modalTitlePlaceholder: "title (or blank for image-only)",
      modalTextLabel: "Body text (optional)",
      modalImageLabel: "Image (optional)",
      createButton: "Create card",
    },

    pieceSets: {
      sectionTitle: "Piece sets (board tiles, standees, tokens)",
      keyPlaceholder: "set key",
      removeSet: "Remove set",
      addSet: "+ Add piece set",
    },

    pieceEntries: {
      symbolPlaceholder: "emoji/symbol, e.g. ⚔️",
      connectorsPlaceholder: "connectors, e.g. north,south",
      readingHint: "reading…",
      remove: "Remove",
      addPiece: "+ Add piece",
      newPieceDefaultSymbol: "⭐",
      // Same modal-on-create treatment as cardEntries, above.
      modalTitle: "New piece",
      modalSymbolLabel: "Symbol/emoji",
      modalImageLabel: "Image (optional, instead of a symbol)",
      modalConnectorsLabel: "Connectors (optional)",
      createButton: "Create piece",
    },

    matSets: {
      sectionTitle: "Mat sets (battle mats, playmats, zone markers)",
      keyPlaceholder: "set key",
      removeSet: "Remove set",
      addSet: "+ Add mat set",
    },

    matEntries: {
      symbolPlaceholder: "emoji/symbol, e.g. 🟩",
      readingHint: "reading…",
      remove: "Remove",
      addMat: "+ Add mat",
      newMatDefaultSymbol: "🟩",
      startsLockedLabel: "Starts locked (GM only can move)",
      // Same modal-on-create treatment as cardEntries/pieceEntries, above.
      modalTitle: "New mat",
      modalSymbolLabel: "Symbol/emoji",
      modalImageLabel: "Image (optional, instead of a symbol)",
      createButton: "Create mat",
    },

    macros: {
      sectionTitle: "Macros (roll buttons)",
      labelPlaceholder: "label",
      rollPlaceholder: "roll, e.g. 1d20 + dex",
      remove: "Remove",
      addMacro: "+ Add macro",
      newMacroDefaultLabel: "New Macro",
      newMacroDefaultRoll: "1d20",
    },
  },

  roomTable: {
    demoCardTitle: (letter: string) => `Card ${letter}`,
    demoCardText: "Demo content",
    placeholderPackageName: "(waiting for game package from host…)",
    inviteLinkCopied: "Copied!",
    inviteLinkButton: "\u{1F517} Invite link",
    youSuffix: " (you)",
    hostSuffix: " • host",
    gmSuffix: " • GM",
    eyesClosedSuffix: " • \u{1F648}",
    connectingHint: "Connecting…",

    // Each help line is split into a bolded lead phrase + the rest of the sentence, so
    // the panel can render the lead as <strong> without regex-splitting one combined
    // string back apart — see ui/RoomTable.tsx's help panel.
    help: {
      cardActionsLead: "Right-click",
      cardActionsRest: " a card: flip, hide, rotate 90°, or (once stacked) shuffle/draw top.",
      cardDragRotate: "Drag the small handle above a card to rotate it freely. Drag one card onto another to stack them.",
      multiSelectLead: "Drag a box",
      multiSelectRest: " over empty table to select several cards, then move/rotate them together, or right-click the selection to flip/hide all of them or collapse them into a deck.",
      pieces: "Pieces (board tiles, standees) never stack — right-click one to rotate it 90° or remove it, or drag its own handle to rotate it freely.",
      cameraLead: "WASD",
      cameraRest: " pans the camera, Q/E rotates it — handy when players are seated on different sides of the table.",
      sync: "Cards and pieces sync live with everyone in the room over a direct connection to the host (falling back to relaying through the server if a direct connection can't be established).",
    },

    backToDashboardTitle: "Back to dashboard",
    spawnCardTitle: "Spawn a random card",
    spawnCardButton: "+ Card",
    openEyesTitle: "Open your eyes",
    closeEyesTitle: "Close your eyes (for reveal moments, e.g. Avalon/Mafia)",
    changeColorTitle: "Change your color",
    chatButton: "\u{1F4AC} Chat",
    howToPlayTitle: "How to play",
    howToPlayButton: "?",
    colorSwatchAriaLabel: (color: string) => `use color ${color}`,
    eyesClosedOverlayText: "\u{1F648} Your eyes are closed.",
  },

  tableMenu: {
    flip: "Flip",
    unhide: "Unhide",
    hide: "Hide",
    rotate90: "Rotate 90°",
    shuffle: "Shuffle",
    drawTopCard: "Draw top card",
    remove: "Remove",
    flipAll: (count: number) => `Flip all (${count})`,
    hideUnhideAll: (count: number) => `Hide/unhide all (${count})`,
    collapseIntoDeck: "Collapse into a deck",
    lockMat: "Lock (GM only can move)",
    unlockMat: "Unlock",
  },
};

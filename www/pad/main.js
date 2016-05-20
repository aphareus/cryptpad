require.config({ paths: { 'json.sortify': '/bower_components/json.sortify/dist/JSON.sortify' } });
define([
    '/api/config?cb=' + Math.random().toString(16).substring(2),
    '/common/messages.js',
    '/common/crypto.js',
    '/common/realtime-input.js',
    '/bower_components/hyperjson/hyperjson.amd.js',
    '/common/hyperscript.js',
    '/common/toolbar.js',
    '/common/cursor.js',
    '/common/json-ot.js',
    '/common/TypingTests.js',
    'json.sortify',
    '/bower_components/textpatcher/TextPatcher.amd.js',
    '/bower_components/diff-dom/diffDOM.js',
    '/bower_components/jquery/dist/jquery.min.js',
    '/customize/pad.js'
], function (Config, Messages, Crypto, realtimeInput, Hyperjson, Hyperscript,
    Toolbar, Cursor, JsonOT, TypingTest, JSONSortify, TextPatcher) {

    var $ = window.jQuery;
    var ifrw = $('#pad-iframe')[0].contentWindow;
    var Ckeditor; // to be initialized later...
    var DiffDom = window.diffDOM;

    var stringify = function (obj) {
        return JSONSortify(obj);
    };

    window.Toolbar = Toolbar;
    window.Hyperjson = Hyperjson;

    var hjsonToDom = function (H) {
        return Hyperjson.callOn(H, Hyperscript);
    };

    var module = window.REALTIME_MODULE = {
        Hyperjson: Hyperjson,
        Hyperscript: Hyperscript,
        TextPatcher: TextPatcher,
        logFights: true,
        fights: []
    };

    var userName = Crypto.rand64(8),
        toolbar;

    var isNotMagicLine = function (el) {
        // factor as:
        // return !(el.tagName === 'SPAN' && el.contentEditable === 'false');
        var filter = (el.tagName === 'SPAN' &&
            el.getAttribute('contentEditable') === 'false' &&
            /position:absolute;border-top:1px dashed/.test(el.getAttribute('style')));
        if (filter) {
            console.log("[hyperjson.serializer] prevented an element" +
                "from being serialized:", el);
            return false;
        }
        return true;
    };

    /* catch `type="_moz"` before it goes over the wire */
    var brFilter = function (hj) {
        if (hj[1].type === '_moz') { hj[1].type = undefined; }
        return hj;
    };

    /*  TODO integrate into flow to prevent browser fights over style */
    var setStyle = function (elem, newStyleAttr) {
        elem.setAttribute("data-chainpad-origstyle", newStyleAttr);
        elem.setAttribute("style", newStyleAttr);
        elem.setAttribute("data-chainpad-styleclone", elem.getAttribute("style"));
    };

    /*  TODO integrate into flow to prevent browser fights over style */
    var getStyle = function (elem) {
        var st = elem.getAttribute("style");
        if (elem.getAttribute("data-chainpad-styleclone") !== st) { return st; }
        return elem.getAttribute("data-chainpad-origstyle");
    };

    var andThen = function (Ckeditor) {
        /*  This is turned off because we prefer that the channel name
            be chosen by the server, not generated by the client.

            We still need a key, so we use genKey()
        */
        // $(window).on('hashchange', function() {
            // window.location.reload();
        // });
        var key;
        var channel = '';
        if (window.location.href.indexOf('#') === -1) {
            key = Crypto.genKey();
            // window.location.href = window.location.href + '#' + Crypto.genKey();
            // return;
        }
        else {
            var hash = window.location.hash.substring(1);
            channel = hash.substr(0,32);
            key = hash.substr(32);
        }

        var fixThings = false;
        var editor = window.editor = Ckeditor.replace('editor1', {
            // https://dev.ckeditor.com/ticket/10907
            needsBrFiller: fixThings,
            needsNbspFiller: fixThings,
            removeButtons: 'Source,Maximize',
            // magicline plugin inserts html crap into the document which is not part of the
            // document itself and causes problems when it's sent across the wire and reflected back
            removePlugins: 'resize'
        });

        editor.on('instanceReady', function (Ckeditor) {
            editor.execCommand('maximize');
            var documentBody = ifrw.$('iframe')[0].contentDocument.body;

            documentBody.innerHTML = Messages.initialState;

            var inner = window.inner = documentBody;
            var cursor = window.cursor = Cursor(inner);

            var setEditable = module.setEditable = function (bool) {
                inner.setAttribute('contenteditable', bool);
            };

            // don't let the user edit until the pad is ready
            setEditable(false);

            var diffOptions = {
                preDiffApply: function (info) {
                    /* DiffDOM will filter out magicline plugin elements
                        in practice this will make it impossible to use it
                        while someone else is typing, which could be annoying.

                        we should check when such an element is going to be
                        removed, and prevent that from happening. */
                    if (info.node && info.node.tagName === 'SPAN' &&
                        info.node.getAttribute('contentEditable') === "false") {
                        // it seems to be a magicline plugin element...
                        if (info.diff.action === 'removeElement') {
                            // and you're about to remove it...
                            // this probably isn't what you want

                            /*
                                I have never seen this in the console, but the
                                magic line is still getting removed on remote
                                edits. This suggests that it's getting removed
                                by something other than diffDom.
                            */
                            console.log("preventing removal of the magic line!");

                            // return true to prevent diff application
                            return true;
                        }
                    }

                    // no use trying to recover the cursor if it doesn't exist
                    if (!cursor.exists()) { return; }

                    /*  frame is either 0, 1, 2, or 3, depending on which
                        cursor frames were affected: none, first, last, or both
                    */
                    var frame = info.frame = cursor.inNode(info.node);

                    if (!frame) { return; }

                    if (typeof info.diff.oldValue === 'string' && typeof info.diff.newValue === 'string') {
                        var pushes = cursor.pushDelta(info.diff.oldValue, info.diff.newValue);

                        if (frame & 1) {
                            // push cursor start if necessary
                            if (pushes.commonStart < cursor.Range.start.offset) {
                                cursor.Range.start.offset += pushes.delta;
                            }
                        }
                        if (frame & 2) {
                            // push cursor end if necessary
                            if (pushes.commonStart < cursor.Range.end.offset) {
                                cursor.Range.end.offset += pushes.delta;
                            }
                        }
                    }
                },
                postDiffApply: function (info) {
                    if (info.frame) {
                        if (info.node) {
                            if (info.frame & 1) { cursor.fixStart(info.node); }
                            if (info.frame & 2) { cursor.fixEnd(info.node); }
                        } else { console.error("info.node did not exist"); }

                        var sel = cursor.makeSelection();
                        var range = cursor.makeRange();

                        cursor.fixSelection(sel, range);
                    }
                }
            };


            var initializing = true;
            var userList = {}; // List of pretty name of all users (mapped with their server ID)
            var toolbarList; // List of users still connected to the channel (server IDs)
            var addToUserList = function(data) {
                for (var attrname in data) { userList[attrname] = data[attrname]; }
                if(toolbarList && typeof toolbarList.onChange === "function") {
                    toolbarList.onChange(userList);
                }
            };

            var myData = {};
            var myUserName = ''; // My "pretty name"
            var myID; // My server ID

            var setMyID = function(info) {
              myID = info.myID || null;
              myUserName = myID;
            };

            var createChangeName = function(id, $container) {
                var buttonElmt = $container.find('#'+id)[0];
                buttonElmt.addEventListener("click", function() {
                   var newName = window.prompt("Change your name :", myUserName);
                   if (newName && newName.trim()) {
                       var myUserNameTemp = newName.trim();
                       if(newName.trim().length > 32) {
                         myUserNameTemp = myUserNameTemp.substr(0, 32);
                       }
                       myUserName = myUserNameTemp;
                       myData[myID] = {
                          name: myUserName
                       };
                       addToUserList(myData);
                       editor.fire( 'change' );
                   }
                });
            };

            var DD = new DiffDom(diffOptions);

            // apply patches, and try not to lose the cursor in the process!
            var applyHjson = function (shjson) {
                var userDocStateDom = hjsonToDom(JSON.parse(shjson));

                // we *might* be able to remove this now
                // changes to hyperscript fixed this bug *maybe* --ansuz
                userDocStateDom.setAttribute("contenteditable", "true"); // lol wtf
                var patch = (DD).diff(inner, userDocStateDom);
                (DD).apply(inner, patch);
            };

            var stringifyDOM = function (dom) {
                var hjson = Hyperjson.fromDOM(dom, isNotMagicLine, brFilter);
                hjson[3] = {metadata: userList};
                return stringify(hjson);
            };

            var realtimeOptions = {
                // provide initialstate...
                initialState: stringifyDOM(inner) || '{}',

                // the websocket URL
                websocketURL: Config.websocketURL,

                // our username
                userName: userName,

                // the channel we will communicate over
                channel: channel,

                // our encryption key
                cryptKey: key,

                // method which allows us to get the id of the user
                setMyID: setMyID,

                // Crypto object to avoid loading it twice in Cryptpad
                crypto: Crypto,

                // really basic operational transform
                transformFunction : JsonOT.validate,

                // cryptpad debug logging (default is 1)
                // logLevel: 0,
            };

            var updateUserList = function(shjson) {
                // Extract the user list (metadata) from the hyperjson
                var hjson = JSON.parse(shjson);
                var peerUserList = hjson[3];
                if(peerUserList && peerUserList.metadata) {
                  var userData = peerUserList.metadata;
                  // Update the local user data
                  addToUserList(userData);
                  hjson.pop();
                }
            };

            var onRemote = realtimeOptions.onRemote = function (info) {
                if (initializing) { return; }

                var shjson = info.realtime.getUserDoc();

                // remember where the cursor is
                cursor.update();

                // Update the user list (metadata) from the hyperjson
                updateUserList(shjson);

                // build a dom from HJSON, diff, and patch the editor
                applyHjson(shjson);

                var shjson2 = stringifyDOM(inner);
                if (shjson2 !== shjson) {
                    console.error("shjson2 !== shjson");
                    module.patchText(shjson2);

                    /*  pushing back over the wire is necessary, but it can
                        result in a feedback loop, which we call a browser
                        fight */
                    if (module.logFights) {
                        // what changed?
                        var op = TextPatcher.diff(shjson, shjson2);
                        // log the changes
                        TextPatcher.log(shjson, op);
                        var sop = JSON.stringify(TextPatcher.format(shjson, op));

                        var index = module.fights.indexOf(sop);
                        if (index === -1) {
                            module.fights.push(sop);
                            console.log("Found a new type of browser disagreement");
                            console.log("You can inspect the list in your " +
                                "console at `REALTIME_MODULE.fights`");
                            console.log(module.fights);
                        } else {
                            console.log("Encountered a known browser disagreement: " +
                                "available at `REALTIME_MODULE.fights[%s]`", index);
                        }
                    }
                }
            };

            var onInit = realtimeOptions.onInit = function (info) {
                var $bar = $('#pad-iframe')[0].contentWindow.$('#cke_1_toolbox');
                toolbarList = info.userList;
                var config = {
                    userData: userList,
                    changeNameID: 'cryptpad-changeName'
                };
                toolbar = info.realtime.toolbar = Toolbar.create($bar, info.myID, info.realtime, info.getLag, info.userList, config);
                createChangeName('cryptpad-changeName', $bar);

                // set the hash
                window.location.hash = info.channel + key;
            };

            // this should only ever get called once, when the chain syncs
            var onReady = realtimeOptions.onReady = function (info) {
                module.patchText = TextPatcher.create({
                    realtime: info.realtime,
                    //logging: true,
                });

                module.realtime = info.realtime;

                var shjson = info.realtime.getUserDoc();
                applyHjson(shjson);

                console.log("Unlocking editor");
                setEditable(true);
                initializing = false;
            };

            var onAbort = realtimeOptions.onAbort = function (info) {
                console.log("Aborting the session!");
                // stop the user from continuing to edit
                setEditable(false);
                // TODO inform them that the session was torn down
                toolbar.failed();
            };

            var onLocal = realtimeOptions.onLocal = function () {
                if (initializing) { return; }

                // stringify the json and send it into chainpad
                var shjson = stringifyDOM(inner);
                module.patchText(shjson);

                if (module.realtime.getUserDoc() !== shjson) {
                    console.error("realtime.getUserDoc() !== shjson");
                }
            };

            var rti = module.realtimeInput = realtimeInput.start(realtimeOptions);

            /* hitting enter makes a new line, but places the cursor inside
                of the <br> instead of the <p>. This makes it such that you
                cannot type until you click, which is rather unnacceptable.
                If the cursor is ever inside such a <br>, you probably want
                to push it out to the parent element, which ought to be a
                paragraph tag. This needs to be done on keydown, otherwise
                the first such keypress will not be inserted into the P. */
            inner.addEventListener('keydown', cursor.brFix);

            editor.on('change', onLocal);

            // export the typing tests to the window.
            // call like `test = easyTest()`
            // terminate the test like `test.cancel()`
            var easyTest = window.easyTest = function () {
                cursor.update();
                var start = cursor.Range.start;
                var test = TypingTest.testInput(inner, start.el, start.offset, onLocal);
                onLocal();
                return test;
            };
        });
    };

    var interval = 100;
    var first = function () {
        Ckeditor = ifrw.CKEDITOR;
        if (Ckeditor) {
            andThen(Ckeditor);
        } else {
            console.log("Ckeditor was not defined. Trying again in %sms",interval);
            setTimeout(first, interval);
        }
    };

    $(first);
});

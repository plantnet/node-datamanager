#!/usr/bin/nodejs
/* 
 * Datamanager Node.js server
 * -----------------------
 * 
 * use POST if you need to send large parameters
 * 
 * config
 * ------
 * [httpd_global_handlers]
 * _dm = {couch_httpd_proxy, handle_proxy_req, <<"http://127.0.0.1:5995">>} 
 *
 * [os_daemons]
 * dm_server = /path/to/nodejs /path/to/user_server.js
 * 
 * 
 * config for admin methods
 * ------------------------
 * a/ local config
 * create a file called admin_db.ini in the same directory, containing
 * 
 * login=login
 * password=pwd
 * host=localhost
 * port=5984
 * 
 * b/ system config - better than local config
 * create a file in /opt/datamanager/dm-admin.ini with the same contents
 * 
 * 
 * user methods
 * ------------
 * 
 * http://127.0.0.1:5984/_dm/db_name/action?param=titi
 * http://127.0.0.1:5984/_dm/db_name/ddoc/action?param=titi
 * 
 * Actions are located in server/action
 * libs are located in server/lib
 * 
 * 
 * admin methods
 * -------------
 * 
 * http://127.0.0.1:5984/_dm/db_name/_admin_db/create?db_name=zzzz
 * http://127.0.0.1:5984/_dm/db_name/_admin_db/drop/db_name=zzzz
 * http://127.0.0.1:5984/_dm/db_name/_admin_db/set_roles?roles={user1 : [role1, role2], user2 : [role1, role2]}
 * http://127.0.0.1:5984/_dm/db_name/_admin_db/set_public?public=true
 * http://127.0.0.1:5984/_dm/db_name/_admin_db/active_tasks
 * http://127.0.0.1:5984/_dm/db_name/_admin_db/replicator_docs
 * http://127.0.0.1:5984/_dm/db_name/_admin_db/user_docs
 * http://127.0.0.1:5984/_dm/db_name/_admin_db/call_remote (needs to POST port, host, db, username, password, action, params)
 * 
 */

var http = require('http'),
    vm = require('vm'),
    url = require('url'),
    couchdb = require('plantnet-node-couchdb'),
    admin = require("./admin");

function log(msg) {
    console.log(JSON.stringify(["log", JSON.stringify(msg)]));
}

process.on('uncaughtException', function(err) {
    log("ERROR : " + err.stack || err.message);
});


/* ActionHandler object is sent to action handler */
var ActionHandler =  function (host, r, method, dbname, db, ddoc_id, action, path, params, clientsPool, client) {
    this.host = host;
    this.r = r;
    this.method = method;
    this.dbname = dbname;
    this.db = db;
    this.action = action;
    this.path = path;
    this.params = params;
    this.ddoc_id = ddoc_id;
    this.ddoc;
    this.clientsPool = clientsPool;
    this.client = client;
};

ActionHandler.cache = {}; // cache for _design/datamanager
ActionHandler.prototype = {};

// initialization
// get code from _design/datamanager doc
// use etag to cache data
ActionHandler.prototype.init = function (cb) {
    var docid = this.ddoc_id; // "_design/datamanager";
    var self = this, etag, key = self.dbname + docid
    cached_doc = ActionHandler.cache[key];

    // cache with etags
    if(cached_doc) { etag = cached_doc._rev; }

    self.db.getDocEtag(docid, etag,
        function (er, data) {
            if(er === 404) {
                throw "wrong doc";
            }
            if(er === 304 && cached_doc) { // not modified
                data = cached_doc;
            } 
            if (data) {
                self.ddoc = data;
                self.ddoc.server = self.ddoc.server || {}
                
                try {
                    ActionHandler.cache[key] = data; // save cache
                    cb();

                } catch (x) {
                    cb(x);
                }
            } else {
                cb("unknown design doc " + docid)
            }
        });
};

//return an error 400
function send_error(resp, err) {

    resp.writeHead(400, {"Content-Type": "application/json"});
    if(typeof err === "string")  {
        err = { error : err };
    }
    resp.end(JSON.stringify(err) + '\n');
}
ActionHandler.prototype.send_error = function(error) {
    send_error(this.r, error);
};

//return a json object (code 200)
function send_json(resp, json_data) {
    resp.writeHead(200, {'Content-Type': 'application/json'});
    resp.end(JSON.stringify(json_data) + '\n');
}
ActionHandler.prototype.send_json = function(data) {
    send_json(this.r, data);
};

// return a file (code 200)
ActionHandler.prototype.send_file = function (str_data, filename) {

    ActionHandler.prototype.start_stream(filename);
    this.r.end(str_data);
};

// starts progressive downloading of a file (code 200))
ActionHandler.prototype.start_stream = function (filename) {

    this.r.writeHead(200, {
        'Content-Type': 'application/force-download',
        //"Content-Transfer-Encoding": "application/octet-stream\n",
        "Content-disposition": "attachment; filename=" + filename,
        //'Content-Length': str_data.length,// + 6, // wtf?
        "Pragma": "no-cache", 
        "Cache-Control": "must-revalidate, post-check=0, pre-check=0, public",
        "Expires": "0"
    });
};

// sends a chunk for progressive downloading
ActionHandler.prototype.send_chunk = function (data) {
    this.r.write(data);
}

// closes stream connection
ActionHandler.prototype.end_stream = function () {
    this.r.end();
}

// get a lib
ActionHandler.prototype.require = function (lib_name) {

    this.ddoc.server.lib_cache = this.ddoc.server.lib_cache || {}; // cache libs
    this.ddoc.server.lib = this.ddoc.server.lib || {};

    var self = this, 
    lib_src = this.ddoc.server.lib[lib_name], 
    exports = {};
    
    var lib_cache = this.ddoc.server.lib_cache;
    
    if(lib_cache[lib_name]) {
        return lib_cache[lib_name];
    }
    
    lib_cache[lib_name] = "processing"; // avoid infinite require loop;

    if(lib_src) {
        try {
            vm.runInNewContext(lib_src, { 
                exports : exports,
                log : function () { log(arguments) }, // closure
                require : function (libname) { // closure
                    if(lib_cache[libname] === "processing") {
                        throw "Infinite loop in require";
                    }
                    return self.require(libname);
                },
                Buffer : Buffer
                
            });
        } catch (x) {
            self.send_error("" + x);
        }
    }

    lib_cache[lib_name] = exports;
    return exports;
};

// run an action
ActionHandler.prototype.run_action = function () {

    this.ddoc.server.action_script = this.ddoc.server.action_script || {};
    
    var self = this, key = this.action + "." + this.method.toLowerCase(),
    action_script = this.ddoc.server.action_script[key];
    
    if (!action_script) {
        var src = this.ddoc.server.action[key] || this.ddoc.server.action[this.action];
        if (!src) {
            self.send_error("unknown action " + this.action);
            return;
        }
        
        try {
            action_script = vm.createScript(src);
            this.ddoc.server.action_script[key] = action_script;
        } catch(x) {
            self.send_error("" + x);
            return;
        }       
    }
        
    
    try {
        // execute action in sandbox
        action_script.runInNewContext({ 
                db : self.db,
                q : self,
                log : function () { log(arguments) }, // closure
                require : function (libname) { // closure
                    return self.require(libname);
                },
                Buffer : Buffer
        });
    } catch (x) {
        self.send_error("" + x);
    }
   
};


/*
 * *********************************************************************
 */

// runs the action of an ActionHandler for a user request
function process_user_req(q) {
    log("run action " + q.action);
    // load code for action
    q.init(function (err, data) {
        if(err) {
            q.send_error(err);
        } else {
            q.run_action();
        }
    });
}

// parses and processes a request
function parse_req(req, res) {

    var parsed_url = url.parse(req.url, true),
        ddoc_id = "_design/datamanager",
        urls = parsed_url.pathname.split("/"),
        dbname = urls[1];

    if (urls[2] == '_admin_db') {
        parse_admin_req(req, res, urls, parsed_url, dbname);
    } else {
        parse_user_req(req, res, urls, parsed_url, ddoc_id, dbname);
    }
}

 // parses an admin request, using authentication from config file
function parse_admin_req(req, res, urls, parsed_url, dbname) {

    var tasks = 2,
        userName,
        roles,
        query = parsed_url.query;

    try {
        var dbname = urls[1],
            action = urls[3];

        if(!dbname || !action) {
            send_error(res, 'bad url');
            return;
        }

        // Create client with cookie to get userCtx
        var userClient = couchdb.createClient(5984, "localhost", null, null, 0, 0, req.headers.cookie);
        userClient.request('/_session', {}, function(err, data) {
            if (err || (! data.ok)) {
                send_error(res, 'error reading user context');
                return;
            }
            userName = data.userCtx.name;
            roles = data.userCtx.roles;
            smallNext();
        });

        // read request body to obtain POST parameters; merge POST and GET parameters
        if (req.method == 'POST') {
            var body = '',
                postParams = {};

            req.on('data', function (data) {
                body += data;
            });

            req.on('end', function () {
                try {
                    postParams = JSON.parse(body);
                } catch(Exception) {
                    postParams = body; // gné?
                }
                //log('REQ BODY: ' + body);
                if (! query) {
                    query = {};
                }
                // mix GET and POST params
                for (var key in postParams) {
                    if (! (key in query)) { // GET params get the priority
                        query[key] = postParams[key];
                    }
                }
                smallNext();
            });
        } else {
            smallNext();
        }

        function smallNext() {
            tasks--;
            if (tasks == 0) {
                //log(query);
                // process the query with libadmin's action handlers
                admin.process_query(action, dbname, userName, roles, query, function(err, data) {
                    if (err) {
                        send_error(res, err);
                    } else {
                        send_json(res, data);
                    }
                });
            }
        }

    } catch (x) {
        log('error in parse_admin_req :' + x);
    }
}

// parses a non-admin request, using current authenticated user's rights
function parse_user_req(req, res, urls, parsed_url, ddoc_id, dbname) {

    try {
        if(urls.length >= 4) {
            ddoc_id = "_design/" + urls[2];
            action = urls[3];
        } else {
            action = urls[2];
        }

        // get user:password
        var auth = req.headers.authorization; // BASIC dfsfefqf
        var user, password;
        if (auth) {
            auth = auth.split(' ')[1]; // 
            auth = new Buffer(auth, 'base64').toString('ascii').split(':');
            user = auth[0];
            password = auth[1];
        }

        var clientsPool = [], // clients pool to achieve parallelization
            poolSize = 10; // pool size
        for (var i=0; i < poolSize; i++) {
            var cl = couchdb.createClient(5984, "localhost", user, password, 0, 0, req.headers.cookie);
            clientsPool.push({
                client: cl,
                db: cl.db(dbname)
            });
        }

        var client = clientsPool[0].client, // retrocompatibility
            db = clientsPool[0].db;

        var q = new ActionHandler(req.headers.host, res, req.method, 
                  dbname, db, ddoc_id, action, urls.slice(1), parsed_url.query, 
                  clientsPool, client);

        if(!dbname || !action) {
            q.send_error("bad url");
            return;
        }

        // POST
        if (req.method == 'POST') {
            var body = '';
            req.on('data', function (data) {
                       body += data;
                   });
            req.on('end', function () {
                try { q.data = JSON.parse(body); }
                catch(Exception) { q.data = body; }

                process_user_req(q);
            });
        } else {
            process_user_req(q);
        }

    } catch (x) {
        log('error in parse_user_req :' + x);
    }
}

function main () {
    http.globalAgent.maxSockets = 20;

    // stdin callback to communicate with couchdb
    var stdin = process.openStdin();
    stdin.on('data', function(d) {});
    stdin.on('end', function () {
        process.exit(0);
    });

    // initialize admin config (authentication, actions list...)
    admin.init();

    // Create http server on 5995
    http.createServer(parse_req).listen(5995, 'localhost');
    log('Datamanager user / admin server listening on port 5995 of localhost');
}

main();

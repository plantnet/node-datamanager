#!/usr/bin/nodejs
/* 
 * Datamanager node server
 * -----------------------
 * 
 *  http://127.0.0.1:5984/_dm/db_name/action?param=titi
 *  http://127.0.0.1:5984/_dm/db_name/ddoc/action?param=titi 
 *
 * Actions are located in server/action
 * libs are located in server/lib
 * 
 * config
 * ------
 * [httpd_global_handlers]
 * _dm = {couch_httpd_proxy, handle_proxy_req, <<"http://127.0.0.1:5995">>}
 *
 * [os_daemons]
 * dm_server = /path/to/nodejs /path/to/user_server.js

 */
 

var
http = require('http'),
vm = require('vm'),
url = require('url'),
couchdb = require('plantnet-node-couchdb');


function log(msg) {
    console.log(JSON.stringify(["log", JSON.stringify(msg)]));  
}

process.on('uncaughtException', function(err) {
               log("ERROR : " + err.stack || err.message);
});



/* ActionHandler object is sent to action handler */
var ActionHandler =  function (r, method, dbname, db, ddoc_id, action, path, params, clientsPool, client) {
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

// return an error 400
ActionHandler.prototype.send_error = function (err) {

    this.r.writeHead(400, {"Content-Type": "application/json"});    
    if(typeof err != "string")  {
        err = JSON.stringify(err);
    }
    this.r.end("{error:'" + err + "'}");
};


// return a json object (code 200)
ActionHandler.prototype.send_json = function (json_data) {

    this.r.writeHead(200, {'Content-Type': 'application/json'});
    this.r.end(JSON.stringify(json_data) +'\n');
};


// return a file (code 200)
ActionHandler.prototype.send_file = function (str_data, filename) {

    this.r.writeHead(200, {
        'Content-Type': 'application/force-download',
        //"Content-Transfer-Encoding": "application/octet-stream\n",
        "Content-disposition": "attachment; filename=" + filename,
        //'Content-Length': str_data.length,// + 6, // wtf?
        "Pragma": "no-cache", 
        "Cache-Control": "must-revalidate, post-check=0, pre-check=0, public",
        "Expires": "0"
    });
    this.r.end(str_data);
};

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
 * */

function process_req(q) {
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


// parse and process an request
function parse_req(req, res) {
    try{
        var parsed_url = url.parse(req.url, true),
        ddoc_id = "_design/datamanager",
        urls = parsed_url.pathname.split("/"),
        dbname = urls[1];
        
        if(urls.length >= 4) {
            ddoc_id = "_design/" + urls[2];
            action = urls[3];
        } else {
            action = urls[2];
        }

        var clientsPool = [], // clients pool to achieve parallelization
            poolSize = 10; // pool size
        for (var i=0; i < poolSize; i++) {
            var cl = couchdb.createClient(5984, "localhost", null, null, 0, 0, req.headers.cookie);
            clientsPool.push({
                client: cl,
                db: cl.db(dbname)
            });
        }

        //var client = couchdb.createClient(5984, "localhost", null, null, 0, 0, req.headers.cookie),
        //db = client.db(dbname);
        var client = clientsPool[0].client, // retrocompatibility
            db = clientsPool[0].db;
        //var q = new ActionHandler(res, req.method, dbname, db, ddoc_id, action, urls.slice(1), parsed_url.query);
        var q = new ActionHandler(res, req.method, dbname, db, ddoc_id, action, urls.slice(1), parsed_url.query, clientsPool, client);

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

                process_req(q);
            });
        } else {
            process_req(q);
        }
        
    } catch (x) {
        log("error :" + x);
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

    // Create http server on 5995
    http.createServer(parse_req).listen(5995);  
    log('Datamanager user server running on port 5995');
}

main();
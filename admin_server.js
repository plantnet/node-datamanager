#!/usr/bin/nodejs
/*
Admin db services

CouchDB Configuration 
---------------------

* config
* ------
* [httpd_global_handlers]
* _admin_db = {couch_httpd_proxy, handle_proxy_req, <<"http://127.0.0.1:5996">>}
*
* [os_daemons]
* admin_server = /path/to/nodejs /path/to/admin_server.js


local Configuration
-------------------

create a file admin_db.ini in the same directory

login=login
password=pwd
host=localhost
port=5984

Usage
-----
http://localhost:5984/_admin/create?db_name=zzzz

http://localhost:5984/_admin/drop?db_name=zzzz

http://localhost:5984/_admin/set_roles?roles={user1 : [role1, role2], user2 : [role1, role2]}&db_name=name

http://localhost:5984/_admin/active_tasks?db_name=name

http://localhost:5984/_admin/set_public?public=true&db_name=name

http://localhost:5984/_admin/user_docs

*/

var
http = require('http'),
url = require('url'),
couchdb = require('plantnet-node-couchdb');
admin = require('admin');

var r;

// return an error 400
function send_error(err) {

    r.writeHead(400, {"Content-Type": "application/json"});    
    if(typeof err != "string")  {
        err = JSON.stringify(err);
    }
    r.end(err);
};


// return a json object (code 200)
function send_json(json_data) {

    r.writeHead(200, {'Content-Type': 'application/json'});
    r.end(JSON.stringify(json_data) +'\n');
};



// parse and process an request
function parse_req(req, res) {
    r = res; // set global object
    
    try{
        var parsed_url = url.parse(req.url, true),
        urls = parsed_url.pathname.split("/"),
        action = urls[1];
    
        if(!action) {
            send_error({ error : "bad url" });
            return;
        }
  
        admin.process_query(action, srcDb, userName, userRoles, query)
             
    } catch (x) {
        log("error :" + x);
    }
}

function main () {
    http.globalAgent.maxSockets = 20;
    
    admin.init(send_json, send_error)

    // stdin callback to communicate with couchdb
    var stdin = process.openStdin();
    stdin.on('data', function(d) {});

    stdin.on('end', function () {
      process.exit(0);
    });

    // Create http server on 5995
    http.createServer(parse_req).listen(5994);  
    log('Datamanager admin server running on port 5994');
}

main();
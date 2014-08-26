node-datamanager
================

Node module for PlantNet-Datamanager

CouchDB config
--------------
<pre>
[httpd_global_handlers]
_dm = {couch_httpd_proxy, handle_proxy_req, <<"http://127.0.0.1:5995">>}

[os_daemons]
dm_server = nodejs /usr/lib/node_modules/plantnet-node-datamanager/user_server.js
</pre>

If security is enabled on couchdb add 

/opt/datamanager/dm-admin.ini

or

a file admin_db.ini in the install directory 

<pre>
login=admin
password=admin
host=localhost
port=5984
</pre>



See http://community.plantnet-project.org/datamanager
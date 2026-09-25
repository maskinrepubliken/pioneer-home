/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = new Collection({
    "createRule": null,
    "deleteRule": null,
    "fields": [
      {
        "autogeneratePattern": "",
        "hidden": false,
        "id": "text3208210256",
        "max": 0,
        "min": 0,
        "name": "id",
        "pattern": "^[a-z0-9]+$",
        "presentable": false,
        "primaryKey": true,
        "required": true,
        "system": true,
        "type": "text"
      },
      {
        "hidden": false,
        "id": "json3192793708",
        "maxSize": 1,
        "name": "temperature",
        "presentable": false,
        "required": false,
        "system": false,
        "type": "json"
      },
      {
        "hidden": false,
        "id": "json2394296326",
        "maxSize": 1,
        "name": "month",
        "presentable": false,
        "required": false,
        "system": false,
        "type": "json"
      }
    ],
    "id": "pbc_2032301178",
    "indexes": [],
    "listRule": null,
    "name": "weatherstatistics",
    "system": false,
    "type": "view",
    "updateRule": null,
    "viewQuery": "SELECT id, AVG(\"temperature\") as \"temperature\",  strftime(\"%m\", \"when\") as \"month\"\nFROM weather\nGROUP BY \"month\"",
    "viewRule": null
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_2032301178");

  return app.delete(collection);
})

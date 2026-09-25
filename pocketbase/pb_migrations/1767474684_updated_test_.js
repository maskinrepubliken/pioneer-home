/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pbc_4223880558")

  // update collection data
  unmarshal({
    "viewQuery": "select id, temperature, humidity, illuminance, location, max(\"when\") as \"when\"\nfrom climate\ngroup by location"
  }, collection)

  // remove field
  collection.fields.removeById("_clone_taRf")

  // remove field
  collection.fields.removeById("_clone_1apq")

  // remove field
  collection.fields.removeById("_clone_4R6A")

  // remove field
  collection.fields.removeById("_clone_5Zpn")

  // remove field
  collection.fields.removeById("_clone_Rv4k")

  // add field
  collection.fields.addAt(1, new Field({
    "hidden": false,
    "id": "_clone_leSX",
    "max": null,
    "min": null,
    "name": "temperature",
    "onlyInt": false,
    "presentable": false,
    "required": false,
    "system": false,
    "type": "number"
  }))

  // add field
  collection.fields.addAt(2, new Field({
    "hidden": false,
    "id": "_clone_NE8j",
    "max": null,
    "min": null,
    "name": "humidity",
    "onlyInt": false,
    "presentable": false,
    "required": false,
    "system": false,
    "type": "number"
  }))

  // add field
  collection.fields.addAt(3, new Field({
    "hidden": false,
    "id": "_clone_2UyF",
    "max": null,
    "min": null,
    "name": "illuminance",
    "onlyInt": false,
    "presentable": false,
    "required": false,
    "system": false,
    "type": "number"
  }))

  // add field
  collection.fields.addAt(4, new Field({
    "autogeneratePattern": "",
    "hidden": false,
    "id": "_clone_Lp9M",
    "max": 0,
    "min": 0,
    "name": "location",
    "pattern": "",
    "presentable": false,
    "primaryKey": false,
    "required": false,
    "system": false,
    "type": "text"
  }))

  // add field
  collection.fields.addAt(5, new Field({
    "hidden": false,
    "id": "json602410524",
    "maxSize": 1,
    "name": "when",
    "presentable": false,
    "required": false,
    "system": false,
    "type": "json"
  }))

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_4223880558")

  // update collection data
  unmarshal({
    "viewQuery": "select id, temperature, humidity, illuminance, location, \"when\"\nfrom climate\ngroup by location"
  }, collection)

  // add field
  collection.fields.addAt(1, new Field({
    "hidden": false,
    "id": "_clone_taRf",
    "max": null,
    "min": null,
    "name": "temperature",
    "onlyInt": false,
    "presentable": false,
    "required": false,
    "system": false,
    "type": "number"
  }))

  // add field
  collection.fields.addAt(2, new Field({
    "hidden": false,
    "id": "_clone_1apq",
    "max": null,
    "min": null,
    "name": "humidity",
    "onlyInt": false,
    "presentable": false,
    "required": false,
    "system": false,
    "type": "number"
  }))

  // add field
  collection.fields.addAt(3, new Field({
    "hidden": false,
    "id": "_clone_4R6A",
    "max": null,
    "min": null,
    "name": "illuminance",
    "onlyInt": false,
    "presentable": false,
    "required": false,
    "system": false,
    "type": "number"
  }))

  // add field
  collection.fields.addAt(4, new Field({
    "autogeneratePattern": "",
    "hidden": false,
    "id": "_clone_5Zpn",
    "max": 0,
    "min": 0,
    "name": "location",
    "pattern": "",
    "presentable": false,
    "primaryKey": false,
    "required": false,
    "system": false,
    "type": "text"
  }))

  // add field
  collection.fields.addAt(5, new Field({
    "hidden": false,
    "id": "_clone_Rv4k",
    "name": "when",
    "onCreate": true,
    "onUpdate": false,
    "presentable": false,
    "system": false,
    "type": "autodate"
  }))

  // remove field
  collection.fields.removeById("_clone_leSX")

  // remove field
  collection.fields.removeById("_clone_NE8j")

  // remove field
  collection.fields.removeById("_clone_2UyF")

  // remove field
  collection.fields.removeById("_clone_Lp9M")

  // remove field
  collection.fields.removeById("json602410524")

  return app.save(collection)
})

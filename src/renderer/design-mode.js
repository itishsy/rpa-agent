'use strict'
document.documentElement.dataset.windowMode=new URLSearchParams(location.search).has('designApp')?'design':'main'

import {workbookToCsv} from './workbookParser';
self.onmessage = async event => {try {self.postMessage({csv:await workbookToCsv(event.data.bytes)});} catch(error) {self.postMessage({error:error.message || 'Invalid workbook'});}};
